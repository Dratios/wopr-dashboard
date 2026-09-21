"""Pilotage des ventilateurs, avec garde-fous.

Prendre la main sur un ventilateur veut dire la retirer au Smart Fan IV du BIOS.
Si le dashboard s'arrête pendant qu'un ventilateur est bloqué à 20 %, la machine
chauffe sans que personne ne surveille. Trois protections en conséquence :

1. **Par défaut, on ne touche à rien.** Tous les ventilateurs restent en mode chip
   (`pwmX_enable = 5`) tant que personne ne demande explicitement autre chose.
2. **Chien de garde thermique.** Un thread relit les températures ; dès qu'un
   capteur dépasse son seuil critique, tous les ventilateurs repassent en mode
   automatique et une entrée d'audit est écrite.
3. **Restitution à l'arrêt.** À l'extinction du service, tout ce qui avait été pris
   en main est rendu au BIOS.

Les courbes s'appliquent côté logiciel : on lit la température de référence, on
interpole le rapport cyclique, on l'écrit. C'est ce qui permet d'avoir des
préréglages qui ne dépendent pas du BIOS.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from . import hardware as hw
from .state_file import load_section, save_section

from . import settings

log = logging.getLogger("wopr.fans")

# Repli ; les valeurs effectives viennent de l'onglet Paramètres.
CONTROL_INTERVAL = 5.0


def _control_interval() -> float:
    try:
        return float(settings.get("fans.controlIntervalS"))
    except Exception:
        return CONTROL_INTERVAL


def _control_chip() -> str:
    try:
        return str(settings.get("fans.controlSensorChip"))
    except Exception:
        return CONTROL_SENSOR_CHIP


def _control_label() -> str:
    try:
        return str(settings.get("fans.controlSensorLabel"))
    except Exception:
        return CONTROL_SENSOR_LABEL

# Préréglages de courbe. Chaque point associe une température de référence (°C)
# à un rapport cyclique (%). Entre deux points, interpolation linéaire.
DEFAULT_PRESETS: Dict[str, List[Dict[str, int]]] = {
    "Silencieux": [
        {"temp": 30, "duty": 20},
        {"temp": 55, "duty": 30},
        {"temp": 70, "duty": 50},
        {"temp": 85, "duty": 100},
    ],
    "Équilibré": [
        {"temp": 30, "duty": 30},
        {"temp": 55, "duty": 45},
        {"temp": 70, "duty": 70},
        {"temp": 82, "duty": 100},
    ],
    "Refroidissement forcé": [
        {"temp": 30, "duty": 55},
        {"temp": 50, "duty": 75},
        {"temp": 65, "duty": 90},
        {"temp": 75, "duty": 100},
    ],
}

# Capteur de référence des courbes : la température du package CPU.
CONTROL_SENSOR_CHIP = "k10temp"
CONTROL_SENSOR_LABEL = "Tctl"


def interpolate(points: List[Dict[str, int]], temp: float) -> int:
    """Rapport cyclique pour une température donnée, par interpolation linéaire."""
    if not points:
        return 50
    ordered = sorted(points, key=lambda p: p["temp"])
    if temp <= ordered[0]["temp"]:
        return int(ordered[0]["duty"])
    if temp >= ordered[-1]["temp"]:
        return int(ordered[-1]["duty"])
    for a, b in zip(ordered, ordered[1:]):
        if a["temp"] <= temp <= b["temp"]:
            span = b["temp"] - a["temp"]
            if span == 0:
                return int(b["duty"])
            ratio = (temp - a["temp"]) / span
            return int(round(a["duty"] + ratio * (b["duty"] - a["duty"])))
    return int(ordered[-1]["duty"])


class FanController:
    def __init__(self, state_path: str, audit=None) -> None:
        self.state_path = state_path
        self.audit = audit
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self.presets: Dict[str, List[Dict[str, int]]] = dict(DEFAULT_PRESETS)
        self.active_preset: Optional[str] = None      # None = on laisse faire le chip
        self.preset_forced_by_mode: Optional[str] = None
        self.manual: Dict[str, int] = {}              # id ventilateur -> duty forcé
        self.failsafe_engaged = False
        self.failsafe_reason: Optional[str] = None

        self._load_state()

    # ------------------------------------------------------------------- état

    def _load_state(self) -> None:
        data = load_section(self.state_path, "fans")
        try:
            self.active_preset = data.get("activePreset")
            self.manual = {k: int(v) for k, v in (data.get("manual") or {}).items()}
            saved = data.get("presets")
            if isinstance(saved, dict) and saved:
                self.presets.update(saved)
        except Exception:
            log.warning("état des ventilateurs illisible, valeurs par défaut")

    def _save_state(self) -> None:
        save_section(self.state_path, "fans", {
            "activePreset": self.active_preset,
            "manual": self.manual,
            "presets": self.presets,
        })

    # ------------------------------------------------------------- inventaire

    def _fan_map(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for chip in hw.hwmon_chips():
            for fan in chip.fans():
                out[f"{chip.name}-fan{fan['index']}"] = fan
        return out

    def available(self) -> bool:
        return bool(self._fan_map())

    def control_temperature(self) -> Optional[float]:
        for chip in hw.hwmon_chips():
            if chip.name == _control_chip():
                for label, celsius in chip.temps():
                    if label == _control_label():
                        return celsius
        # Repli : la température la plus élevée relevée sur la machine.
        temps = [c for chip in hw.hwmon_chips() for _, c in chip.temps()]
        return max(temps) if temps else None

    def _critical_sensor(self) -> Optional[str]:
        for chip in hw.hwmon_chips():
            _, crit = hw.sensor_thresholds(chip.name)
            for label, celsius in chip.temps():
                if celsius >= crit:
                    return f"{hw.sensor_label(chip.name, label)} à {celsius:.1f} °C"
        return None

    # ------------------------------------------------------------------ actions

    def set_manual(self, fan_id: str, duty_pct: int, user: str = "système") -> tuple[bool, str]:
        with self._lock:
            if self.failsafe_engaged:
                return False, "chien de garde thermique actif : contrôle manuel refusé"
            fan = self._fan_map().get(fan_id)
            if not fan:
                return False, f"ventilateur « {fan_id} » introuvable"
            if not fan["controllable"]:
                return False, "ce ventilateur n'a pas de sortie PWM pilotable"
            if not hw.set_fan_manual(fan["pwmPath"], fan["enablePath"], duty_pct):
                return False, "écriture PWM refusée (le conteneur a-t-il /sys en écriture ?)"
            self.manual[fan_id] = duty_pct
            self._save_state()
            self._record(user, fan_id, f"ventilateur forcé à {duty_pct} %")
            return True, f"{duty_pct} %"

    def set_auto(self, fan_id: str, user: str = "système") -> tuple[bool, str]:
        with self._lock:
            fan = self._fan_map().get(fan_id)
            if not fan:
                return False, f"ventilateur « {fan_id} » introuvable"
            if not hw.set_fan_auto(fan["enablePath"]):
                return False, "écriture PWM refusée"
            self.manual.pop(fan_id, None)
            self._save_state()
            self._record(user, fan_id, "ventilateur rendu au pilotage de la carte mère")
            return True, "auto"

    def set_curve_mode(self, fan_id: str, user: str = "système") -> tuple[bool, str]:
        """Place un ventilateur sous la courbe active du dashboard."""
        with self._lock:
            if not self.active_preset:
                return False, "aucun préréglage de courbe actif"
            fan = self._fan_map().get(fan_id)
            if not fan:
                return False, f"ventilateur « {fan_id} » introuvable"
            if not fan["controllable"]:
                return False, "ce ventilateur n'a pas de sortie PWM pilotable"
            self.manual.pop(fan_id, None)
            self._save_state()
            self._record(user, fan_id, f"ventilateur suit la courbe « {self.active_preset} »")
            self._apply_curve()
            return True, self.active_preset

    def set_preset(self, preset: Optional[str], user: str = "système",
                   forced_by_mode: Optional[str] = None) -> tuple[bool, str]:
        with self._lock:
            if preset is not None and preset not in self.presets:
                return False, f"préréglage « {preset} » inconnu"
            self.active_preset = preset
            self.preset_forced_by_mode = forced_by_mode
            self._save_state()

            if preset is None:
                # Retour intégral au pilotage de la carte mère.
                for fan_id, fan in self._fan_map().items():
                    if fan["controllable"]:
                        hw.set_fan_auto(fan["enablePath"])
                self.manual.clear()
                self._save_state()
                self._record(user, "ventilateurs", "pilotage rendu à la carte mère")
                return True, "auto"

            self._record(user, "ventilateurs", f"préréglage « {preset} » activé")
            self._apply_curve()
            return True, preset

    def update_curve_point(self, index: int, temp: int, duty: int,
                           user: str = "système") -> tuple[bool, str]:
        with self._lock:
            if not self.active_preset:
                return False, "aucun préréglage actif à modifier"
            points = self.presets[self.active_preset]
            if not (0 <= index < len(points)):
                return False, "point de courbe inexistant"
            points[index] = {"temp": max(0, min(110, temp)), "duty": max(0, min(100, duty))}
            self._save_state()
            self._record(user, self.active_preset,
                         f"point {index + 1} de la courbe réglé à {temp} °C / {duty} %")
            self._apply_curve()
            return True, f"{temp} °C → {duty} %"

    # ------------------------------------------------------------ boucle de fond

    def _apply_curve(self) -> None:
        """Applique la courbe active aux ventilateurs qui ne sont pas en manuel."""
        if not self.active_preset or self.failsafe_engaged:
            return
        temp = self.control_temperature()
        if temp is None:
            return
        duty = interpolate(self.presets[self.active_preset], temp)
        for fan_id, fan in self._fan_map().items():
            if fan_id in self.manual or not fan["controllable"]:
                continue
            hw.set_fan_manual(fan["pwmPath"], fan["enablePath"], duty)

    def _engage_failsafe(self, reason: str) -> None:
        log.error("chien de garde thermique déclenché : %s", reason)
        self.failsafe_engaged = True
        self.failsafe_reason = reason
        for fan in self._fan_map().values():
            if fan["controllable"]:
                hw.set_fan_auto(fan["enablePath"])
        self._record("système", "ventilateurs",
                     f"chien de garde thermique : pilotage rendu à la carte mère ({reason})",
                     result="attention")

    def _release_failsafe(self) -> None:
        log.info("température revenue sous le seuil critique, pilotage de nouveau permis")
        self.failsafe_engaged = False
        self.failsafe_reason = None
        self._record("système", "ventilateurs",
                     "température normalisée, pilotage du dashboard de nouveau autorisé",
                     result="info")

    def start(self) -> None:
        if self._thread is not None or not self.available():
            return

        def loop() -> None:
            while not self._stop.wait(_control_interval()):
                try:
                    with self._lock:
                        critical = self._critical_sensor()
                        if critical and not self.failsafe_engaged:
                            self._engage_failsafe(critical)
                        elif not critical and self.failsafe_engaged:
                            self._release_failsafe()

                        if not self.failsafe_engaged:
                            self._apply_curve()
                            # Réapplique les consignes manuelles : le chip peut
                            # reprendre la main tout seul après certains événements.
                            for fan_id, duty in list(self.manual.items()):
                                fan = self._fan_map().get(fan_id)
                                if fan and fan["controllable"]:
                                    hw.set_fan_manual(fan["pwmPath"], fan["enablePath"], duty)
                except Exception:
                    log.exception("erreur dans la boucle de contrôle des ventilateurs")

        self._thread = threading.Thread(target=loop, name="wopr-fans", daemon=True)
        self._thread.start()
        log.info("contrôle des ventilateurs démarré (%d ventilateur(s))", len(self._fan_map()))

    def resume(self) -> None:
        """Relance la boucle de contrôle après un `shutdown()` qui n'a pas abouti
        (redémarrage de la machine refusé) : sans cela, les courbes n'étaient plus
        appliquées alors que l'interface les annonçait actives."""
        if self._thread is not None:
            self._thread.join(timeout=_control_interval() + 1)
        self._stop.clear()
        self._thread = None
        self.start()

    def shutdown(self) -> None:
        """Rend tous les ventilateurs au BIOS avant de s'éteindre."""
        self._stop.set()
        restored = 0
        for fan in self._fan_map().values():
            if fan["controllable"] and hw.set_fan_auto(fan["enablePath"]):
                restored += 1
        if restored:
            log.info("%d ventilateur(s) rendu(s) au pilotage de la carte mère", restored)
            self._record("système", "ventilateurs",
                         "arrêt du service : pilotage rendu à la carte mère", result="info")

    # ------------------------------------------------------------------- lecture

    def effective_mode(self, fan_id: str, hw_mode: str, controllable: bool) -> Dict[str, Any]:
        """Mode réel d'un ventilateur, vu du dashboard.

        Le noyau ne connaît que « PWM manuel » (`pwmX_enable = 1`) : un ventilateur
        qui suit une courbe du dashboard y apparaît donc « manuel ». On traduit ici
        avec ce que le contrôleur sait de ses propres consignes.
        """
        with self._lock:
            if fan_id in self.manual:
                return {"mode": "manual", "sourceSensor": None}
            if self.active_preset and controllable and not self.failsafe_engaged:
                return {"mode": "curve", "sourceSensor": f"{_control_chip()} {_control_label()}"}
        # Hors dashboard : PWM manuel laissé par autre chose, sinon la carte mère.
        return {"mode": "manual" if hw_mode == "manual" else "auto", "sourceSensor": None}

    def curve_state(self) -> Dict[str, Any]:
        return {
            "curvePresets": sorted(self.presets.keys()),
            "activeCurvePreset": self.active_preset,
            "presetForcedByMode": self.preset_forced_by_mode,
            "currentCurvePoints": self.presets.get(self.active_preset, []) if self.active_preset else [],
            "controlTempC": self.control_temperature(),
            "failsafeEngaged": self.failsafe_engaged,
            "failsafeReason": self.failsafe_reason,
            "manualFans": dict(self.manual),
        }

    def _record(self, user: str, target: str, detail: str, result: str = "succès") -> None:
        if self.audit:
            self.audit.record(user, "fan", target, detail, result)
