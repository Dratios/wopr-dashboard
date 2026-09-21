"""Évaluation des alertes à partir de l'état réel de la machine.

Les alertes de la maquette étaient un tableau figé. Ici elles sont recalculées à
chaque rafraîchissement à partir des mesures, selon les seuils de
`config/thresholds.yaml`.

Deux propriétés qui comptent en usage réel :

- **Identifiants stables.** Une alerte garde le même identifiant tant que la
  condition dure, ce qui permet de conserver son heure d'apparition (« depuis
  14:32 ») et son acquittement d'un rafraîchissement à l'autre.
- **Acquittement révocable.** Acquitter masque l'alerte ; si la condition
  disparaît puis revient, l'alerte réapparaît non acquittée — sinon un problème
  récurrent finirait par ne plus jamais se voir.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

import yaml

from . import confwrite, settings, telegram
from .state_file import load_section, save_section

log = logging.getLogger("wopr.alerts")


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


DEFAULTS: Dict[str, Any] = {
    "disque": {"warnPct": 80, "critPct": 92, "parMontage": {}},
    "charge": {"warnRatio": 1.0, "critRatio": 1.5},
    "memoire": {"warnPct": 85, "critPct": 95, "swapWarnPct": 50},
    "gpu": {"vramWarnPct": 88, "vramCritPct": 96, "vramTelegram": False,
            "tempWarnC": 80, "tempCritC": 88},
    "docker": {"restartsWarn": 3, "restartsCrit": 10, "signalerArretsInattendus": True},
    "reseau": {"erreursWarn": 100, "gatewayWarnMs": 20},
    "systeme": {"signalerRebootRequis": True, "signalerAbsencePareFeu": True},
}


class AlertEngine:
    def __init__(self, config_path: str, state_path: str) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self._lock = threading.Lock()
        self.config = dict(DEFAULTS)
        # id -> {"since": iso, "acknowledged": bool}
        self._tracked: Dict[str, Dict[str, Any]] = {}
        self._last: List[Dict[str, Any]] = []
        self._load_config()
        self._load_state()
        self._migrate_vram_telegram()
        global _engine
        _engine = self

    def _load_config(self) -> None:
        config = {section: dict(values) if isinstance(values, dict) else values
                  for section, values in DEFAULTS.items()}
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
            for section, values in loaded.items():
                if isinstance(values, dict):
                    config.setdefault(section, {}).update(values)
                else:
                    config[section] = values
        except FileNotFoundError:
            log.warning("%s absent, seuils par défaut utilisés", self.config_path)
        except Exception:
            log.warning("seuils illisibles dans %s, valeurs par défaut utilisées",
                        self.config_path)
        self.config = config

    def reload(self) -> None:
        """Relit `thresholds.yaml` et remplace les seuils sans redémarrage.

        Appelé après une écriture depuis l'onglet Paramètres. Le verrou est celui
        des alertes : l'échange se fait entre deux évaluations, jamais pendant.
        """
        with self._lock:
            self._load_config()
        log.info("seuils rechargés depuis %s", self.config_path)

    def raw_config(self) -> Dict[str, Any]:
        with self._lock:
            return {k: (dict(v) if isinstance(v, dict) else v) for k, v in self.config.items()}

    def _migrate_vram_telegram(self) -> None:
        """`gpu.vramTelegram` devient une ligne du tableau des familles.

        Ce drapeau était la seule exception au filtrage par niveau ; il est
        remplacé par un réglage par famille, plus général. On le reprend une fois,
        puis on le retire du fichier pour qu'il n'existe plus deux endroits où
        régler la même chose.
        """
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
        except Exception:
            return
        gpu_cfg = loaded.get("gpu")
        if not isinstance(gpu_cfg, dict) or "vramTelegram" not in gpu_cfg:
            return

        stored = settings.get_raw("notifications.families", {}) or {}
        if "vram" not in stored:
            stored = dict(stored)
            stored["vram"] = {"level": "inherit" if gpu_cfg["vramTelegram"] else "never",
                              "resolved": True}
            settings.set_raw("notifications.families", stored)
            log.info("gpu.vramTelegram repris dans les règles de notification (famille VRAM)")

        gpu_cfg.pop("vramTelegram", None)
        try:
            confwrite.backup(self.config_path)
            confwrite.atomic_write(
                self.config_path,
                yaml.safe_dump(loaded, allow_unicode=True, sort_keys=False,
                               default_flow_style=False))
        except Exception:
            log.warning("gpu.vramTelegram n'a pas pu être retiré de %s "
                        "(config en lecture seule ?)", self.config_path)

    def _load_state(self) -> None:
        self._tracked = load_section(self.state_path, "alerts")

    def _save_state(self) -> None:
        save_section(self.state_path, "alerts", self._tracked)

    def mount_thresholds(self, path: str) -> Dict[str, int]:
        """Seuils d'occupation d'un montage, surcharges de `thresholds.yaml` comprises.

        Exposés avec les montages pour que la vue colore une barre selon les mêmes
        seuils que ceux qui déclenchent les alertes.
        """
        disk_cfg = self.config["disque"]
        override = (disk_cfg.get("parMontage") or {}).get(path, {})
        return {
            "warnPct": override.get("warnPct", disk_cfg["warnPct"]),
            "critPct": override.get("critPct", disk_cfg["critPct"]),
        }

    # --------------------------------------------------------------- évaluation

    def evaluate(self, cpu_ram: Dict[str, Any], thermal: Dict[str, Any],
                 storage: Dict[str, Any], docker_data: Dict[str, Any],
                 gpu_data: Dict[str, Any], system: Dict[str, Any]) -> List[Dict[str, Any]]:
        raw: List[Dict[str, Any]] = []

        def add(aid: str, level: str, component: str, message: str,
                notify: bool = True) -> None:
            raw.append({"id": aid, "level": level, "component": component,
                        "message": message, "notify": notify})

        cfg = self.config

        # --- Températures ----------------------------------------------------
        for s in thermal.get("sensors", []):
            if s["tempC"] >= s["critC"]:
                add(f"temp-{s['id']}", "err", s["label"],
                    f"Température critique : {s['tempC']} °C (seuil {s['critC']} °C)")
            elif s["tempC"] >= s["warnC"]:
                add(f"temp-{s['id']}", "warn", s["label"],
                    f"Température élevée : {s['tempC']} °C (seuil {s['warnC']} °C)")

        # --- Ventilateurs ----------------------------------------------------
        for f in thermal.get("fans", []):
            if f.get("fault") == "stall":
                add(f"fan-{f['id']}", "err", f["label"],
                    f"Ventilateur à l'arrêt alors qu'il est commandé à {f['dutyPct']} %")
        if thermal.get("failsafeEngaged"):
            add("fan-failsafe", "err", "Ventilation",
                f"Chien de garde thermique déclenché : {thermal.get('failsafeReason')}")

        # --- Disques ---------------------------------------------------------
        disk_cfg = cfg["disque"]
        for m in storage.get("mounts", []):
            if m.get("reachable") is False:
                add(f"mount-{m['path']}", "err", m["path"],
                    f"Montage injoignable ({m['device']})")
                continue
            limits = self.mount_thresholds(m["path"])
            warn, crit = limits["warnPct"], limits["critPct"]
            free = m["totalGiB"] - m["usedGiB"]
            if m["usedPct"] >= crit:
                add(f"disk-{m['path']}", "err", m["path"],
                    f"Espace disque critique : {m['usedPct']} % occupés, {free:.0f} Gio libres")
            elif m["usedPct"] >= warn:
                add(f"disk-{m['path']}", "warn", m["path"],
                    f"Espace disque à surveiller : {m['usedPct']} % occupés, {free:.0f} Gio libres")

        # --- Charge et mémoire -----------------------------------------------
        threads = cpu_ram["cpu"].get("threads") or 1
        load5 = cpu_ram["cpu"]["loadavg"][1]
        ratio = load5 / threads
        if ratio >= cfg["charge"]["critRatio"]:
            add("load", "err", "Processeur",
                f"Charge très élevée : {load5} sur 5 min pour {threads} threads")
        elif ratio >= cfg["charge"]["warnRatio"]:
            add("load", "warn", "Processeur",
                f"Charge soutenue : {load5} sur 5 min pour {threads} threads")

        ram = cpu_ram["ram"]
        if ram["totalGiB"]:
            ram_pct = ram["usedGiB"] / ram["totalGiB"] * 100
            if ram_pct >= cfg["memoire"]["critPct"]:
                add("ram", "err", "Mémoire vive",
                    f"Mémoire presque saturée : {ram_pct:.0f} % utilisés")
            elif ram_pct >= cfg["memoire"]["warnPct"]:
                add("ram", "warn", "Mémoire vive",
                    f"Mémoire fortement occupée : {ram_pct:.0f} % utilisés")
        if ram["swapTotalGiB"]:
            swap_pct = ram["swapUsedGiB"] / ram["swapTotalGiB"] * 100
            if swap_pct >= cfg["memoire"]["swapWarnPct"]:
                add("swap", "warn", "Mémoire vive",
                    f"Recours important au fichier d'échange : {swap_pct:.0f} %")

        # --- GPU -------------------------------------------------------------
        gpu_cfg = cfg["gpu"]
        # Un modèle LLM chargé remplit la VRAM à chaque prompt : c'est normal.
        # Que cette alerte parte ou non sur Telegram se règle désormais dans
        # l'onglet Paramètres, ligne « VRAM des GPU » du tableau des familles.
        for g in gpu_data.get("gpus", []):
            label = f"GPU {g['index']} — {g['name']}"
            if g["memTotalMiB"]:
                vram_pct = g["memUsedMiB"] / g["memTotalMiB"] * 100
                if vram_pct >= gpu_cfg["vramCritPct"]:
                    add(f"vram-{g['index']}", "err", label,
                        f"VRAM saturée : {vram_pct:.0f} % de {g['memTotalMiB']} Mio")
                elif vram_pct >= gpu_cfg["vramWarnPct"]:
                    add(f"vram-{g['index']}", "warn", label,
                        f"VRAM très occupée : {vram_pct:.0f} %")
            temp = g.get("tempC")
            if temp is not None:
                if temp >= gpu_cfg["tempCritC"]:
                    add(f"gputemp-{g['index']}", "err", label,
                        f"Température critique : {temp} °C")
                elif temp >= gpu_cfg["tempWarnC"]:
                    add(f"gputemp-{g['index']}", "warn", label,
                        f"Température élevée : {temp} °C")

        # --- Docker ----------------------------------------------------------
        docker_cfg = cfg["docker"]
        for stack in docker_data.get("stacks", []):
            for c in stack["containers"]:
                label = f"{c['name']} ({stack['name']})"
                if c["state"] == "restarting":
                    add(f"ctr-{c['id']}", "err", label,
                        "Conteneur en boucle de redémarrage")
                elif c["health"] == "unhealthy":
                    add(f"ctr-{c['id']}", "err", label,
                        "Le healthcheck du conteneur échoue")
                elif (docker_cfg.get("signalerArretsInattendus")
                      and c["state"] == "stopped"
                      and c.get("restartPolicy") in ("unless-stopped", "always")):
                    add(f"ctr-{c['id']}", "warn", label,
                        "Conteneur arrêté alors que sa politique est de redémarrer seul")

                restarts = c.get("restarts") or 0
                if restarts >= docker_cfg["restartsCrit"]:
                    add(f"ctrrestart-{c['id']}", "err", label,
                        f"{restarts} redémarrages enregistrés")
                elif restarts >= docker_cfg["restartsWarn"]:
                    add(f"ctrrestart-{c['id']}", "warn", label,
                        f"{restarts} redémarrages enregistrés")

        if docker_data.get("available") is False:
            add("docker-down", "err", "Démon Docker",
                docker_data.get("unavailableReason") or "démon injoignable")

        # --- Réseau ----------------------------------------------------------
        net_cfg = cfg["reseau"]
        for i in storage.get("interfaces", []):
            if i.get("virtual") or not i["up"]:
                continue
            errors = (i.get("rxErrors") or 0) + (i.get("txErrors") or 0)
            if errors >= net_cfg["erreursWarn"]:
                add(f"net-{i['name']}", "warn", f"Interface {i['name']}",
                    f"{errors} erreurs cumulées sur le lien")

        gateway = storage.get("gateway") or {}
        if gateway.get("pingMs") is None and gateway.get("ip"):
            add("gateway", "err", "Réseau",
                f"Passerelle {gateway['ip']} injoignable")
        elif (gateway.get("pingMs") or 0) >= net_cfg["gatewayWarnMs"]:
            add("gateway", "warn", "Réseau",
                f"Latence élevée vers la passerelle : {gateway['pingMs']} ms")

        # --- Système ---------------------------------------------------------
        sys_cfg = cfg["systeme"]
        if sys_cfg.get("signalerRebootRequis") and system.get("needsReboot"):
            add("reboot", "warn", "Système",
                "Un redémarrage est requis pour finaliser des mises à jour")

        firewall = storage.get("firewall") or {}
        if sys_cfg.get("signalerAbsencePareFeu") and firewall.get("active") is False:
            add("firewall", "info", "Sécurité réseau",
                firewall.get("detail") or "Aucun pare-feu actif sur l'hôte")

        return self._reconcile(raw)

    def _reconcile(self, raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Conserve l'ancienneté et l'acquittement des alertes qui persistent.

        Calcule aussi le diff apparition/résolution pour les notifications
        Telegram : seul ce code, qui tient `self._lock`, peut le faire sans
        condition de course entre les trois points d'appel (`/api/alerts`,
        `/api/overview`, tick websocket).
        """
        now = _iso()
        with self._lock:
            current_ids = {a["id"] for a in raw}
            previous_ids = set(self._tracked)

            appeared_ids = current_ids - previous_ids
            resolved_ids = previous_ids - current_ids

            # Capturer les alertes résolues avant de les oublier : une fois
            # effacées de `_tracked`, si la condition revient elle revient non
            # acquittée (comportement d'origine, inchangé).
            resolved_alerts = [
                {**self._tracked[rid], "id": rid} for rid in resolved_ids
            ]
            for rid in resolved_ids:
                self._tracked.pop(rid, None)

            out: List[Dict[str, Any]] = []
            changed = bool(resolved_ids)
            for alert in raw:
                tracked = self._tracked.get(alert["id"])
                if tracked is None:
                    tracked = {"since": now, "acknowledged": False}
                    self._tracked[alert["id"]] = tracked
                    changed = True
                tracked["level"] = alert["level"]
                tracked["component"] = alert["component"]
                tracked["message"] = alert["message"]
                tracked["notify"] = alert["notify"]
                out.append({**alert,
                            "since": tracked["since"],
                            "acknowledged": tracked["acknowledged"]})

            if changed:
                self._save_state()

        # Hors du verrou : ce chemin ne fait qu'empiler dans une file, mais
        # autant garder la section critique aussi courte que possible puisque
        # trois points d'appel la partagent.
        # Le filtrage (famille, niveau, heures calmes, anti-répétition) appartient
        # entièrement à `telegram.py` : ici on ne fait que signaler les
        # transitions. Une famille réglée sur « tout » reçoit donc aussi les
        # alertes de niveau information, ce que l'ancien filtre interdisait.
        for alert in raw:
            if alert["id"] in appeared_ids and alert["notify"]:
                telegram.notify_alert(alert, resolved=False)
        for alert in resolved_alerts:
            if alert.get("notify", True):
                telegram.notify_alert(alert, resolved=True)

        order = {"err": 0, "warn": 1, "info": 2}
        out.sort(key=lambda a: (a["acknowledged"], order.get(a["level"], 3), a["since"]))
        self._last = out
        return out

    def acknowledge(self, alert_id: str) -> bool:
        with self._lock:
            tracked = self._tracked.get(alert_id)
            if tracked is None:
                return False
            tracked["acknowledged"] = True
            self._save_state()
            return True


# Dernier moteur instancié. `telegram.py` s'en sert pour les relances périodiques :
# il a besoin de savoir si une alerte notifiée il y a deux heures est toujours là.
_engine: Optional[AlertEngine] = None


def last_known() -> List[Dict[str, Any]]:
    return list(_engine._last) if _engine is not None else []
