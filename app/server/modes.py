"""Modes / profils machine.

Un mode est un jeu de politiques appliqué d'un coup à la machine. Les modes sont
**déclarés dans `config/modes.yaml`**, pas dans le code : ils se modifient sans
rebuild de l'image.

Choix de conception important : ne figurent ici que les leviers que l'on sait
réellement actionner sur cette machine. La maquette d'origine affichait aussi
« mises à jour auto suspendues », « notifications en sourdine », « mise en veille »
et « limites de ressources des conteneurs » — rien de tout cela n'avait de
mécanisme derrière. Plutôt que de laisser l'interface annoncer des effets qui ne
se produisent pas, ces leviers ont été retirés. Les leviers réels sont :

- le gouverneur CPU et la préférence énergie/performance (amd-pstate-epp) ;
- la limite de puissance de chaque carte GPU (NVML) ;
- le préréglage de courbe des ventilateurs ;
- la durée de rétention des modèles en VRAM par Ollama ;
- l'arrêt/démarrage de conteneurs **nommés explicitement** — aucun par défaut,
  pour ne jamais surprendre l'autre administrateur du serveur.

Chaque application de mode rend compte levier par levier : l'UI affiche ce qui a
réellement été appliqué, et ce qui a échoué.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import yaml

from . import settings
from .state_file import load_section, save_section

log = logging.getLogger("wopr.modes")

# Mode de repli, appliqué au démarrage et au terme d'un retour automatique.
# Réglable depuis l'onglet Paramètres ; la constante reste le dernier recours.
FALLBACK_MODE_ID = "equilibre"


def default_mode_id() -> str:
    try:
        return str(settings.get("modes.defaultId")) or FALLBACK_MODE_ID
    except Exception:
        return FALLBACK_MODE_ID


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


class ModeEngine:
    def __init__(
        self,
        config_path: str,
        state_path: str,
        gpu_manager,
        fan_controller,
        docker_manager,
        audit=None,
    ) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self.gpu = gpu_manager
        self.fans = fan_controller
        self.docker = docker_manager
        self.audit = audit

        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self.modes: Dict[str, Dict[str, Any]] = {}
        self.active_id: str = default_mode_id()
        self.activated_by: str = "système"
        self.activated_at: str = _iso()
        self.reason: str = "état initial"
        self.auto_revert_at: Optional[float] = None
        self.history: List[Dict[str, Any]] = []
        self.last_application: List[Dict[str, Any]] = []

        self._load_config()
        self._load_state()

    # --------------------------------------------------------------- chargement

    def _load_config(self) -> None:
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            modes = data.get("modes") or []
            self.modes = {m["id"]: m for m in modes if "id" in m}
            log.info("%d mode(s) chargé(s) depuis %s", len(self.modes), self.config_path)
        except Exception:
            log.exception("lecture de %s impossible : aucun mode disponible", self.config_path)
            self.modes = {}

    def reload(self) -> None:
        """Relit `modes.yaml` sans redémarrage, après écriture depuis Paramètres.

        Le mode actif est conservé s'il existe toujours ; sinon on retombe sur le
        mode de repli, sans rien réappliquer au matériel — changer une définition
        n'est pas changer de mode.
        """
        with self._lock:
            self._load_config()
            if self.active_id not in self.modes:
                log.warning("le mode actif %s n'existe plus, repli sur %s",
                            self.active_id, default_mode_id())
                self.active_id = default_mode_id()
                self._save_state()

    def raw_config(self) -> Dict[str, Any]:
        """Contenu de `modes.yaml` tel quel, pour l'éditeur de l'onglet Paramètres."""
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f) or {"modes": []}
        except Exception:
            return {"modes": []}

    def _load_state(self) -> None:
        data = load_section(self.state_path, "mode")
        if data.get("activeId") in self.modes:
            self.active_id = data["activeId"]
            self.activated_by = data.get("activatedBy", "système")
            self.activated_at = data.get("activatedAt", _iso())
            self.reason = data.get("reason", "")
            self.auto_revert_at = data.get("autoRevertAt")
        self.history = (data.get("history") or [])[-50:]

    def _save_state(self) -> None:
        save_section(self.state_path, "mode", {
            "activeId": self.active_id,
            "activatedBy": self.activated_by,
            "activatedAt": self.activated_at,
            "reason": self.reason,
            "autoRevertAt": self.auto_revert_at,
            "history": self.history[-50:],
        })

    # ------------------------------------------------------------- application

    def _resolve_power_limit(self, card: Dict[str, Any], spec: Any) -> Optional[int]:
        """Traduit une consigne de power limit pour une carte donnée.

        Accepte un nombre de watts, `"max"`, `"min"`, ou un pourcentage de la plage
        propre à la carte (`"70%"`). Le pourcentage est ce qui permet à un mode de
        rester valide quand une deuxième carte, de plage différente, est ajoutée.
        """
        rng = card.get("powerLimitRangeW")
        if not rng:
            return None
        lo, hi = rng
        if isinstance(spec, (int, float)):
            return max(lo, min(hi, int(spec)))
        if isinstance(spec, str):
            spec = spec.strip()
            if spec == "max":
                return hi
            if spec == "min":
                return lo
            if spec.endswith("%"):
                try:
                    pct = float(spec[:-1]) / 100.0
                except ValueError:
                    return None
                return int(round(lo + (hi - lo) * max(0.0, min(1.0, pct))))
        return None

    def _apply(self, mode: Dict[str, Any], user: str,
               include_fans: bool = True) -> List[Dict[str, Any]]:
        """Applique les leviers et rend compte de chacun."""
        policies = mode.get("policies") or {}
        results: List[Dict[str, Any]] = []

        def note(lever: str, ok: bool, detail: str) -> None:
            results.append({"lever": lever, "ok": ok, "detail": detail})

        # --- CPU -------------------------------------------------------------
        from . import hardware as hw

        gov = policies.get("cpuGovernor")
        if gov:
            ok, detail = hw.set_cpu_governor(gov)
            note("Gouverneur CPU", ok, detail)

        epp = policies.get("cpuEpp")
        if epp:
            ok, detail = hw.set_cpu_epp(epp)
            note("Préférence énergie CPU", ok, detail)

        # --- GPU -------------------------------------------------------------
        gpu_spec = policies.get("gpuPowerLimit")
        if gpu_spec is not None:
            cards = self.gpu.read_cards()
            if not cards:
                note("Limite de puissance GPU", False, "aucune carte NVIDIA détectée")
            for card in cards:
                # Une consigne peut être globale, ou indexée par carte.
                spec = gpu_spec.get(str(card["index"]), gpu_spec.get("all")) \
                    if isinstance(gpu_spec, dict) else gpu_spec
                if spec is None:
                    continue
                watts = self._resolve_power_limit(card, spec)
                if watts is None:
                    note(f"GPU {card['index']} ({card['name']})", False,
                         f"consigne « {spec} » inapplicable à cette carte")
                    continue
                ok, detail = self.gpu.set_power_limit(card["index"], watts)
                note(f"GPU {card['index']} ({card['name']})", ok, detail)

        # --- Ventilateurs ----------------------------------------------------
        if include_fans and "fanCurvePreset" in policies:
            preset = policies["fanCurvePreset"]
            if self.fans.available():
                ok, detail = self.fans.set_preset(preset, user=user, forced_by_mode=mode["id"])
                note("Courbe ventilateurs", ok, detail)
            else:
                note("Courbe ventilateurs", False,
                     "aucun ventilateur pilotable exposé par le noyau")

        # --- Ollama ----------------------------------------------------------
        keep_alive = policies.get("ollamaKeepAlive")
        if keep_alive is not None:
            models = self.gpu.loaded_models(self.gpu.read_cards())
            if not models:
                note("Rétention des modèles", True, "aucun modèle chargé")
            for m in models:
                ok, detail = self.gpu.load_model(m["name"], keep_alive=keep_alive)
                note(f"Modèle {m['name']}", ok,
                     f"rétention VRAM → {keep_alive}" if ok else detail)

        # --- Conteneurs ------------------------------------------------------
        containers = policies.get("containers") or {}
        for action in ("stop", "start"):
            for name in containers.get(action) or []:
                ok = self.docker.container_action(name, action)
                note(f"Conteneur {name}", ok,
                     f"{action} exécuté" if ok else f"{action} impossible")

        return results

    # ------------------------------------------------------------------ public

    def set_mode(self, mode_id: str, user: str, reason: str = "",
                 revert_minutes: int = 0) -> Dict[str, Any]:
        with self._lock:
            mode = self.modes.get(mode_id)
            if not mode:
                raise KeyError(f"mode « {mode_id} » inconnu")

            previous = self.active_id
            results = self._apply(mode, user)

            self.active_id = mode_id
            self.activated_by = user
            self.activated_at = _iso()
            self.reason = reason or "changement manuel"
            self.auto_revert_at = (
                time.time() + revert_minutes * 60 if revert_minutes > 0 else None
            )
            self.last_application = results

            entry = {
                "id": str(int(time.time() * 1000)),
                "at": self.activated_at,
                "by": user,
                "from": previous,
                "to": mode_id,
                "reason": self.reason,
                "autoRevertAt": _iso(self.auto_revert_at) if self.auto_revert_at else None,
            }
            self.history.append(entry)
            self._save_state()

            failures = [r for r in results if not r["ok"]]
            if self.audit:
                self.audit.record(
                    user, "mode", mode_id,
                    f"mode « {mode.get('label', mode_id)} » activé"
                    + (f" ({len(failures)} levier(s) en échec)" if failures else ""),
                    "attention" if failures else "succès",
                    {"from": previous, "reason": self.reason, "levers": results},
                )

            return {"mode": mode_id, "applied": results, "history": entry}

    def extend(self, minutes: int, user: str) -> Optional[str]:
        with self._lock:
            base = self.auto_revert_at or time.time()
            self.auto_revert_at = base + minutes * 60
            self._save_state()
            if self.audit:
                self.audit.record(user, "mode", self.active_id,
                                  f"retour automatique repoussé de {minutes} min")
            return _iso(self.auto_revert_at)

    def revert(self, user: str, reason: str = "retour manuel") -> Dict[str, Any]:
        return self.set_mode(default_mode_id(), user, reason)

    def start(self) -> None:
        if self._thread is not None:
            return

        def loop() -> None:
            while not self._stop.wait(10.0):
                try:
                    with self._lock:
                        if self.auto_revert_at and time.time() >= self.auto_revert_at:
                            log.info("retour automatique au mode par défaut")
                            self.auto_revert_at = None
                            self.set_mode(default_mode_id(), "règle auto",
                                          "retour automatique programmé")
                except Exception:
                    log.exception("erreur dans la boucle des modes")

        self._thread = threading.Thread(target=loop, name="wopr-modes", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def reapply(self, user: str = "système") -> None:
        """Réapplique le mode courant — au démarrage du service, pour que l'état
        de la machine corresponde à ce que l'interface affiche.

        Les ventilateurs sont exclus : leur préréglage et leurs consignes manuelles
        sont persistés par `FanController` et reflètent le dernier choix, éventuellement
        fait après l'activation du mode. Réappliquer le préréglage du mode (souvent
        `null` en Équilibré) effaçait ces réglages à chaque redémarrage du dashboard.
        """
        mode = self.modes.get(self.active_id)
        if mode:
            self.last_application = self._apply(mode, user, include_fans=False)

    # ------------------------------------------------------------------ lecture

    def active_summary(self) -> Dict[str, Any]:
        mode = self.modes.get(self.active_id, {})
        remaining = None
        if self.auto_revert_at:
            remaining = max(0, int((self.auto_revert_at - time.time()) / 60))
        return {
            "id": self.active_id,
            "label": mode.get("label", self.active_id),
            "icon": mode.get("icon", "gauge"),
            "since": self.activated_at,
            "activatedBy": self.activated_by,
            "reason": self.reason,
            "autoRevertAt": _iso(self.auto_revert_at) if self.auto_revert_at else None,
            "remainingMinutes": remaining,
        }

    def get_modes_data(self) -> Dict[str, Any]:
        return {
            "active": self.active_id,
            "activeDetail": self.active_summary(),
            "lastApplication": self.last_application,
            "modes": [
                {
                    "id": m["id"],
                    "label": m.get("label", m["id"]),
                    "icon": m.get("icon", "gauge"),
                    "description": m.get("description", ""),
                    "policies": m.get("policies", {}),
                }
                for m in self.modes.values()
            ],
            # La planification horaire n'est pas implémentée : plutôt que d'afficher
            # des règles décoratives, la liste est vide et l'UI le dit.
            "schedules": [],
            "history": list(reversed(self.history[-30:])),
        }
