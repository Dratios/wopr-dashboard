"""Collecte des métriques réelles de l'hôte.

Principe tenu partout dans ce fichier : **aucune donnée inventée**. Si une mesure
n'est pas disponible, le champ vaut `None` et l'UI affiche une indisponibilité
explicite. Un chiffre affiché est un chiffre mesuré.

Les formes renvoyées suivent `src/state/types.ts` — c'est le contrat entre le
backend et les vues, et il fait autorité.
"""

from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

import psutil

from . import hardware as hw
from .hostexec import host

from . import settings

log = logging.getLogger("wopr.collector")

# Profondeurs de repli. Les valeurs effectives viennent de l'onglet Paramètres
# (`collect.memoryPoints`, `collect.sampleIntervalS`) et sont relues à chaud.
HISTORY_POINTS = 120       # ~10 minutes à un échantillon toutes les 5 s
HISTORY_INTERVAL = 5.0
SENSOR_HISTORY_POINTS = 60   # 5 minutes
NIC_HISTORY_POINTS = 30      # 2 min 30


def _history_points() -> int:
    try:
        return int(settings.get("collect.memoryPoints"))
    except Exception:
        return HISTORY_POINTS


def _sample_interval() -> float:
    try:
        return float(settings.get("collect.sampleIntervalS"))
    except Exception:
        return HISTORY_INTERVAL


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


def _hhmm(ts: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts))


# Interfaces qui ne portent pas de trafic « réel » de la machine : la boucle locale,
# et les interfaces virtuelles de Docker. Le trafic d'un conteneur traverse sa veth,
# puis le pont, puis la carte physique : les additionner le comptait trois fois.
VIRTUAL_NIC_PREFIXES = ("br-", "docker", "veth", "virbr", "tun", "tap")


def _is_virtual_nic(name: str) -> bool:
    return name == "lo" or name.startswith(VIRTUAL_NIC_PREFIXES)


class _TtlCache:
    """Mémorise une valeur coûteuse à produire et qui change lentement."""

    def __init__(self) -> None:
        self._values: Dict[str, Tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, ttl: float, producer):
        now = time.time()
        with self._lock:
            hit = self._values.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        value = producer()
        with self._lock:
            self._values[key] = (now, value)
        return value


class MetricsHistory:
    """Historique glissant alimenté par un thread de fond.

    Les vues affichent des courbes ; sans historique côté serveur, chaque client
    repartirait de zéro à l'ouverture et un rechargement de page effacerait tout.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        depth = _history_points()
        self._depth = depth
        self.t: Deque[float] = deque(maxlen=depth)
        self.series: Dict[str, Deque[float]] = {
            k: deque(maxlen=depth)
            for k in ("cpu", "load1", "load5", "ramUsed", "ramPct", "gpu",
                      "tempMax", "netRx", "netTx")
        }
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self, sample_fn) -> None:
        if self._thread is not None:
            return
        self._sample_fn = sample_fn

        def loop() -> None:
            # Cadence et profondeur relues à chaque tour : un changement dans
            # l'onglet Paramètres prend effet au tour suivant, sans redémarrage.
            while not self._stop.wait(_sample_interval()):
                try:
                    self._resize(_history_points())
                    self.push(self._sample_fn())
                except Exception:
                    log.exception("échec d'un échantillon d'historique")

        self._thread = threading.Thread(target=loop, name="wopr-history", daemon=True)
        self._thread.start()

    def _resize(self, depth: int) -> None:
        """Change la profondeur des séries en conservant les points déjà mesurés."""
        if depth == self._depth:
            return
        with self._lock:
            self._depth = depth
            self.t = deque(self.t, maxlen=depth)
            self.series = {k: deque(v, maxlen=depth) for k, v in self.series.items()}
        log.info("profondeur de l'historique mémoire portée à %d points", depth)

    def stop(self) -> None:
        self._stop.set()

    def push(self, sample: Dict[str, float]) -> None:
        with self._lock:
            self.t.append(time.time())
            for key, series in self.series.items():
                series.append(float(sample.get(key, 0.0)))

    def snapshot(self) -> Dict[str, List[Any]]:
        with self._lock:
            return {
                "t": list(self.t),
                **{k: list(v) for k, v in self.series.items()},
            }


class SystemCollector:
    def __init__(self) -> None:
        self.boot_time = psutil.boot_time()
        self.cpu_model = self._detect_cpu_model()
        self.dmi = hw.dmi()
        self.rapl = hw.RaplMeter()
        self.history = MetricsHistory()

        # Historique court par capteur, pour la variation et les courbes de la vue
        # thermique. Alimenté uniquement par le thread d'historique (un point toutes
        # les 5 s) : quand chaque lecture de l'API ajoutait un point, la cadence
        # dépendait du nombre d'onglets ouverts et les horodatages étaient faux.
        self._sensor_history: Dict[str, Deque[Tuple[float, float]]] = {}
        # Régime moyen des ventilateurs, même cadence et mêmes horodatages que les
        # capteurs : superposé aux températures, il montre si la ventilation suit.
        # Le tr/min et non le PWM : en Smart Fan IV, le registre PWM reste à 255
        # quel que soit le régime réel.
        self._fan_history: Deque[Tuple[float, float]] = deque(maxlen=SENSOR_HISTORY_POINTS)
        # Débits par interface physique, même cadence.
        self._nic_history: Dict[str, Tuple[Deque[float], Deque[float]]] = {}
        self._history_lock = threading.Lock()
        self._slow = _TtlCache()

        # Un état de compteurs par appelant : partagé, deux lectures rapprochées
        # (historique et API) donnaient un intervalle de quelques millisecondes et
        # des débits instantanés aberrants.
        self._net_prev: Dict[str, Tuple[Dict[str, Any], float]] = {}
        self._disk_prev: Dict[str, Any] = {}
        self._disk_prev_time = time.time()

        # Amorce les compteurs différentiels : sans ça le premier appel renvoie 0
        # partout, ce que l'ancienne version affichait comme une vraie mesure.
        psutil.cpu_percent(percpu=True, interval=None)
        for p in psutil.process_iter(["cpu_percent"]):
            pass
        self._read_net_rates("history")
        self._read_net_rates("api")
        self._read_disk_rates()
        self.rapl.read_watts()

    # ------------------------------------------------------------------- outils

    @staticmethod
    def _detect_cpu_model() -> str:
        try:
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass
        return platform.processor() or "processeur inconnu"

    def sample_for_history(self) -> Dict[str, float]:
        cpu = psutil.cpu_percent(interval=None)
        vm = psutil.virtual_memory()
        net = self._read_net_rates("history")
        physical = {name: r for name, r in net.items() if not _is_virtual_nic(name)}
        now = time.time()
        sensors = list(self._iter_sensors())
        temps = [celsius for _, _, _, celsius in sensors]
        rpms = [fan["rpm"] for chip in hw.hwmon_chips() for fan in chip.fans()]
        with self._history_lock:
            for sensor_id, _, _, celsius in sensors:
                self._sensor_history.setdefault(
                    sensor_id, deque(maxlen=SENSOR_HISTORY_POINTS)).append((now, celsius))
            if rpms:
                self._fan_history.append((now, sum(rpms) / len(rpms)))
            for name, r in physical.items():
                rx, tx = self._nic_history.setdefault(
                    name, (deque(maxlen=NIC_HISTORY_POINTS), deque(maxlen=NIC_HISTORY_POINTS)))
                rx.append(r["rx"])
                tx.append(r["tx"])
        from .gpu import gpu_manager  # import tardif : évite un cycle d'imports
        gpu_util = gpu_manager.average_utilisation()
        return {
            "cpu": cpu,
            "load1": os.getloadavg()[0],
            "load5": os.getloadavg()[1],
            "ramUsed": (vm.total - vm.available) / (1024 ** 3),
            "ramPct": vm.percent,
            "gpu": gpu_util if gpu_util is not None else 0.0,
            "tempMax": max(temps) if temps else 0.0,
            "netRx": sum(v["rx"] for v in physical.values()),
            "netTx": sum(v["tx"] for v in physical.values()),
            # Clés propres à l'historique longue durée (history_db) ; ignorées par
            # MetricsHistory, qui ne conserve que les siennes.
            **{f"temp:{sensor_id}": celsius for sensor_id, _, _, celsius in sensors},
            **({"fan:avg": sum(rpms) / len(rpms)} if rpms else {}),
        }

    @staticmethod
    def _iter_sensors():
        """(identifiant stable, puce, libellé brut, °C) de chaque capteur retenu."""
        idx = 0
        for chip in hw.hwmon_chips():
            for raw_label, celsius in chip.temps():
                yield f"{chip.name}-{idx}", chip.name, raw_label, celsius
                idx += 1

    def _all_temps(self) -> List[Tuple[str, float]]:
        out: List[Tuple[str, float]] = []
        for chip in hw.hwmon_chips():
            for label, celsius in chip.temps():
                out.append((hw.sensor_label(chip.name, label), celsius))
        return out

    # --------------------------------------------------------------- CPU et RAM

    def get_cpu_ram(self) -> Dict[str, Any]:
        per_thread = psutil.cpu_percent(percpu=True, interval=None)
        util = round(sum(per_thread) / len(per_thread), 1) if per_thread else 0.0

        freq = psutil.cpu_freq()
        gov = hw.cpu_governors()

        vm = psutil.virtual_memory()
        swap = psutil.swap_memory()

        watts = self.rapl.read_watts()

        top_cpu, top_mem = self._top_processes()

        hist = self.history.snapshot()
        cpu_history = [
            {
                "time": _hhmm(t),
                "util": round(c, 1),
                "load1": round(l1, 2),
                "load5": round(l5, 2),
            }
            for t, c, l1, l5 in zip(hist["t"], hist["cpu"], hist["load1"], hist["load5"])
        ]
        ram_history = [
            {"time": _hhmm(t), "usedGiB": round(u, 2)}
            for t, u in zip(hist["t"], hist["ramUsed"])
        ]

        cpu_temp = self._cpu_package_temp()

        return {
            "cpu": {
                "model": self.cpu_model,
                "cores": psutil.cpu_count(logical=False) or 0,
                "threads": psutil.cpu_count(logical=True) or 0,
                "utilPct": util,
                "freqMhzAvg": round(freq.current) if freq and freq.current else None,
                "freqMhzMax": round(freq.max) if freq and freq.max else None,
                "governor": gov["governor"],
                "governorAvailable": gov["available"],
                "epp": gov["epp"],
                "eppAvailable": gov["eppAvailable"],
                "scalingDriver": gov["driver"],
                "tempPkgC": cpu_temp,
                "powerW": watts,
                # L'UI doit pouvoir dire « mesuré » plutôt que laisser croire
                # qu'une estimation est une mesure.
                "powerSource": "rapl" if self.rapl.available and watts is not None else None,
                "perThread": [round(x, 1) for x in per_thread],
                "loadavg": [round(x, 2) for x in os.getloadavg()],
                "topCpu": top_cpu,
                "history": cpu_history,
            },
            "ram": {
                "totalGiB": round(vm.total / (1024 ** 3), 1),
                "usedGiB": round((vm.total - vm.available) / (1024 ** 3), 1),
                "cacheGiB": round(getattr(vm, "cached", 0) / (1024 ** 3), 1),
                "freeGiB": round(vm.available / (1024 ** 3), 1),
                "swapUsedGiB": round(swap.used / (1024 ** 3), 1),
                "swapTotalGiB": round(swap.total / (1024 ** 3), 1),
                "topMem": top_mem,
                "history": ram_history,
            },
            "motherboard": {
                "model": f"{self.dmi['vendor']} {self.dmi['board']}".strip(),
                "biosVersion": self.dmi["biosVersion"],
                "biosDate": self.dmi["biosDate"],
                "voltages": self._voltages(),
                "temps": [
                    {"name": name, "value": round(celsius, 1)}
                    for name, celsius in self._all_temps()
                ],
            },
        }

    def _cpu_package_temp(self) -> Optional[float]:
        for chip in hw.hwmon_chips():
            if chip.name == "k10temp":
                for label, celsius in chip.temps():
                    if label == "Tctl":
                        return round(celsius, 1)
        return None

    def _voltages(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for chip in hw.hwmon_chips():
            out.extend(chip.voltages())
        return out

    def _top_processes(self) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        procs = []
        for p in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_info"]):
            try:
                procs.append(p.info)
            except Exception:
                continue

        by_cpu = sorted(procs, key=lambda i: i.get("cpu_percent") or 0, reverse=True)[:5]
        by_mem = sorted(
            procs,
            key=lambda i: i["memory_info"].rss if i.get("memory_info") else 0,
            reverse=True,
        )[:5]

        top_cpu = [
            {
                "pid": i["pid"],
                "name": i.get("name") or "?",
                "user": i.get("username") or "",
                "cpuPct": round(i.get("cpu_percent") or 0, 1),
            }
            for i in by_cpu
        ]
        top_mem = [
            {
                "pid": i["pid"],
                "name": i.get("name") or "?",
                "user": i.get("username") or "",
                "rssMiB": round(i["memory_info"].rss / (1024 ** 2)) if i.get("memory_info") else 0,
            }
            for i in by_mem
        ]
        return top_cpu, top_mem

    # -------------------------------------------------------------- thermique

    def get_thermal(self, fan_controller=None) -> Dict[str, Any]:
        sensors: List[Dict[str, Any]] = []
        fans: List[Dict[str, Any]] = []

        with self._history_lock:
            histories = {k: list(v) for k, v in self._sensor_history.items()}
            fan_history = list(self._fan_history)

        for sensor_id, chip_name, raw_label, celsius in self._iter_sensors():
            warn, crit = hw.sensor_thresholds(chip_name)
            series = histories.get(sensor_id, [])
            # Variation sur ~30 s : 6 points à 5 s d'intervalle.
            previous = series[-7][1] if len(series) >= 7 else None
            delta = round(celsius - previous, 1) if previous is not None else None
            sensors.append({
                "id": sensor_id,
                "label": hw.sensor_label(chip_name, raw_label),
                "tempC": round(celsius, 1),
                "warnC": warn,
                "critC": crit,
                "source": chip_name,
                "delta": delta,
                "spark": [round(v, 1) for _, v in series[-20:]],
                "history": [{"time": _hhmm(t), "temp": round(v, 1)} for t, v in series],
            })

        for chip in hw.hwmon_chips():
            for fan in chip.fans():
                fan_id = f"{chip.name}-fan{fan['index']}"
                effective = (fan_controller.effective_mode(fan_id, fan["mode"], fan["controllable"])
                             if fan_controller else {"mode": fan["mode"], "sourceSensor": None})
                fans.append({
                    "id": fan_id,
                    "label": f"Ventilateur {fan['index']} ({chip.name})",
                    "rpm": fan["rpm"],
                    "dutyPct": fan["dutyPct"],
                    "mode": effective["mode"],
                    "sourceSensor": effective["sourceSensor"],
                    "controllable": fan["controllable"],
                    "fault": fan["fault"],
                })

        fans_available = bool(fans)
        reason = None
        if not fans_available:
            reason = (
                "Aucun contrôleur de ventilateur exposé par le noyau. "
                "Le module `nct6775` (Super I/O Nuvoton de cette carte mère) n'est "
                "pas chargé — `sudo modprobe nct6775` sur l'hôte."
            )

        curve = fan_controller.curve_state() if fan_controller else {
            "curvePresets": [], "activeCurvePreset": "",
            "presetForcedByMode": None, "currentCurvePoints": [],
        }

        return {
            "sensors": sensors,
            "fans": fans,
            "fanHistory": [{"time": _hhmm(t), "rpm": round(v)} for t, v in fan_history],
            "fansAvailable": fans_available,
            "fansUnavailableReason": reason,
            **curve,
        }

    # ------------------------------------------------------- stockage et réseau

    def _read_disk_rates(self) -> Dict[str, Dict[str, float]]:
        now = time.time()
        counters = psutil.disk_io_counters(perdisk=True) or {}
        dt = max(0.001, now - self._disk_prev_time)
        rates: Dict[str, Dict[str, float]] = {}
        for name, c in counters.items():
            prev = self._disk_prev.get(name)
            if prev is not None:
                rates[name] = {
                    "readMBs": max(0.0, (c.read_bytes - prev.read_bytes) / (1024 ** 2) / dt),
                    "writeMBs": max(0.0, (c.write_bytes - prev.write_bytes) / (1024 ** 2) / dt),
                    "iops": max(0.0, ((c.read_count + c.write_count)
                                      - (prev.read_count + prev.write_count)) / dt),
                }
        self._disk_prev = counters
        self._disk_prev_time = now
        return rates

    def _read_net_rates(self, caller: str) -> Dict[str, Dict[str, float]]:
        now = time.time()
        counters = psutil.net_io_counters(pernic=True) or {}
        prev_counters, prev_time = self._net_prev.get(caller, ({}, now))
        dt = max(0.001, now - prev_time)
        rates: Dict[str, Dict[str, float]] = {}
        for name, c in counters.items():
            prev = prev_counters.get(name)
            if prev is not None:
                rates[name] = {
                    "rx": max(0.0, (c.bytes_recv - prev.bytes_recv) / (1024 ** 2) / dt),
                    "tx": max(0.0, (c.bytes_sent - prev.bytes_sent) / (1024 ** 2) / dt),
                }
            else:
                rates[name] = {"rx": 0.0, "tx": 0.0}
        self._net_prev[caller] = (counters, now)
        return rates

    @staticmethod
    def _device_basename(device: str) -> Optional[str]:
        """`/dev/mapper/ubuntu--vg-ubuntu--lv` → nom présent dans /proc/diskstats."""
        if not device.startswith("/dev/"):
            return None
        name = device[5:]
        if name.startswith("mapper/"):
            try:
                real = os.path.realpath(device)
                name = os.path.basename(real)
            except Exception:
                return None
        return name

    def get_storage_network(self) -> Dict[str, Any]:
        disk_rates = self._read_disk_rates()
        mounts: List[Dict[str, Any]] = []

        for m in hw.host_mounts():
            path = m["path"]
            probe = hw.host_path(path)
            try:
                usage = shutil.disk_usage(probe)
            except Exception:
                # Un NFS injoignable ne doit pas faire disparaître la ligne :
                # on la montre explicitement comme injoignable.
                mounts.append({
                    "path": path, "fs": m["fs"], "device": m["device"],
                    "type": hw.classify_device(m["device"], m["fs"]),
                    "usedGiB": 0, "totalGiB": 0, "usedPct": 0, "inodePct": 0,
                    "readMBs": 0, "writeMBs": 0, "iops": 0,
                    "smart": "unknown", "reachable": False,
                    "latencyMs": None, "powerOnHours": None, "tbw": None, "wearPct": None,
                })
                continue

            if usage.total == 0:
                continue

            dev_name = self._device_basename(m["device"])
            rate = disk_rates.get(dev_name or "", {})

            inode_pct = 0.0
            try:
                st = os.statvfs(probe)
                if st.f_files:
                    inode_pct = round((st.f_files - st.f_ffree) / st.f_files * 100, 1)
            except Exception:
                pass

            mounts.append({
                "path": path,
                "fs": m["fs"],
                "device": m["device"],
                "type": hw.classify_device(m["device"], m["fs"]),
                "usedGiB": round(usage.used / (1024 ** 3), 1),
                "totalGiB": round(usage.total / (1024 ** 3), 1),
                "usedPct": round(usage.used / usage.total * 100, 1),
                "inodePct": inode_pct,
                "readMBs": round(rate.get("readMBs", 0.0), 2),
                "writeMBs": round(rate.get("writeMBs", 0.0), 2),
                "iops": round(rate.get("iops", 0.0)),
                "tempC": self._device_temp(dev_name),
                "latencyMs": self._mount_latency(m["device"], m["fs"]),
                # SMART change à l'échelle des heures : inutile d'appeler `nvme`
                # sur l'hôte à chaque rafraîchissement.
                **self._slow.get(f"smart:{dev_name}", 60, lambda d=dev_name: self._nvme_smart(d)),
                "reachable": True,
            })

        return {
            "mounts": sorted(mounts, key=lambda x: -x["totalGiB"]),
            "interfaces": self._interfaces(),
            "listeners": self._listeners(),
            "firewall": self._slow.get("firewall", 60, self._firewall),
            "gateway": self._ping_target(hw.default_gateway()),
            "internet": self._ping_target(str(settings.get("general.pingTarget"))),
        }

    def _nvme_smart(self, dev_name: Optional[str]) -> Dict[str, Any]:
        """Usure et compteurs SMART d'un SSD NVMe.

        Lus via `nvme smart-log` sur l'hôte. Les valeurs manquantes restent à None :
        l'ancienne version affichait un total d'écriture (TBW) purement inventé.

        `smart` vaut « unknown » tant que rien n'a été lu (disque SATA, NFS, lecture
        en échec) : un « ok » par défaut afficherait un disque sain sans l'avoir mesuré.
        """
        empty = {"smart": "unknown", "powerOnHours": None, "tbw": None, "wearPct": None}
        if not dev_name or not dev_name.startswith("nvme"):
            return empty

        # On interroge le contrôleur, pas la partition : nvme0n1p1 -> nvme0n1
        base = re.sub(r"p\d+$", "", dev_name)
        res = host.run("nvme", ["smart-log", f"/dev/{base}", "-o", "json"], timeout=10)
        if not res.ok:
            return empty

        try:
            import json as _json
            data = _json.loads(res.stdout)
        except Exception:
            return empty

        # `data_units_written` se compte en unités de 512 000 octets (norme NVMe).
        written = data.get("data_units_written")
        tbw = round(written * 512_000 / (1000 ** 4), 2) if written else None
        # Le nom de la clé dépend de la version de nvme-cli : wopr renvoie
        # `percent_used`, d'autres versions `percentage_used`.
        used = data.get("percent_used", data.get("percentage_used"))
        critical = data.get("critical_warning", 0)
        if isinstance(critical, dict):  # certaines versions détaillent les bits
            critical = critical.get("value", 0)

        return {
            "smart": "err" if critical else ("warn" if (used or 0) >= 80 else "ok"),
            "powerOnHours": data.get("power_on_hours"),
            "tbw": tbw,
            "wearPct": used,
        }

    def _mount_latency(self, device: str, fstype: str) -> Optional[float]:
        """Latence réseau d'un montage distant.

        N'a de sens que pour du NFS : on mesure le temps d'aller-retour vers le
        serveur, extrait de la partie avant « : » du périphérique.
        """
        if not fstype.startswith("nfs") or ":" not in device:
            return None
        server = device.split(":", 1)[0]
        return self._ping_target(server).get("pingMs")

    @staticmethod
    def _device_temp(dev_name: Optional[str]) -> Optional[float]:
        """Température du contrôleur NVMe qui porte ce périphérique.

        La puce hwmon `nvme` est rattachée à son contrôleur (`nvme0`) : on la
        retrouve par ce lien, sinon deux SSD afficheraient la température du premier.
        """
        if not dev_name or not dev_name.startswith("nvme"):
            return None
        controller = re.sub(r"n\d+(p\d+)?$", "", dev_name)
        for chip in hw.hwmon_chips():
            if chip.name != "nvme":
                continue
            if os.path.basename(os.path.realpath(os.path.join(chip.path, "device"))) != controller:
                continue
            for label, celsius in chip.temps():
                if label.lower().startswith("composite"):
                    return round(celsius, 1)
        return None

    def _interfaces(self) -> List[Dict[str, Any]]:
        rates = self._read_net_rates("api")
        counters = psutil.net_io_counters(pernic=True) or {}
        stats = psutil.net_if_stats()
        addrs = psutil.net_if_addrs()
        with self._history_lock:
            nic_history = {k: (list(rx), list(tx)) for k, (rx, tx) in self._nic_history.items()}

        out: List[Dict[str, Any]] = []
        for name, st in stats.items():
            if name == "lo":
                continue
            ipv4 = ""
            mac = ""
            for a in addrs.get(name, []):
                if a.family.name == "AF_INET" and not ipv4:
                    ipv4 = a.address
                elif a.family.name == "AF_PACKET":
                    mac = a.address
            c = counters.get(name)
            r = rates.get(name, {"rx": 0.0, "tx": 0.0})

            out.append({
                "name": name,
                "up": st.isup,
                "ipv4": ipv4,
                "mac": mac,
                "speedMbps": st.speed or 0,
                "duplex": {0: "inconnu", 1: "half", 2: "full"}.get(int(st.duplex), "inconnu"),
                "mtu": st.mtu,
                "rxMBs": round(r["rx"], 2),
                "txMBs": round(r["tx"], 2),
                "rxErrors": c.errin if c else 0,
                "txErrors": c.errout if c else 0,
                "rxTotalGiB": round(c.bytes_recv / (1024 ** 3), 2) if c else 0,
                "txTotalGiB": round(c.bytes_sent / (1024 ** 3), 2) if c else 0,
                # Historique propre à cette interface (vide pour les virtuelles).
                "rxHistory": [round(v, 2) for v in nic_history.get(name, ([], []))[0]],
                "txHistory": [round(v, 2) for v in nic_history.get(name, ([], []))[1]],
                # Les ponts Docker sont réels mais secondaires : l'UI les range à part.
                "virtual": _is_virtual_nic(name),
            })

        out.sort(key=lambda i: (i["virtual"], not i["up"], i["name"]))
        return out

    def _listeners(self) -> List[Dict[str, Any]]:
        """Ports réellement en écoute, avec le processus derrière."""
        out: List[Dict[str, Any]] = []
        seen = set()
        try:
            conns = psutil.net_connections(kind="inet")
        except Exception:
            log.warning("énumération des sockets impossible")
            return out

        for c in conns:
            if c.status != psutil.CONN_LISTEN and c.type != 2:  # 2 = SOCK_DGRAM
                continue
            if not c.laddr:
                continue
            proto = "tcp" if c.type == 1 else "udp"
            key = (c.laddr.port, proto, c.laddr.ip)
            if key in seen:
                continue
            seen.add(key)

            name = "?"
            container = None
            if c.pid:
                try:
                    p = psutil.Process(c.pid)
                    name = p.name()
                    container = self._container_of(c.pid)
                except Exception:
                    pass

            out.append({
                "port": c.laddr.port,
                "proto": proto,
                "process": name,
                "pid": c.pid,
                "listen": c.laddr.ip,
                "container": container,
            })

        out.sort(key=lambda x: (x["port"], x["proto"]))
        return out

    @staticmethod
    def _container_of(pid: int) -> Optional[str]:
        """Identifiant court du conteneur propriétaire d'un PID, via son cgroup."""
        try:
            with open(f"/proc/{pid}/cgroup", "r") as f:
                content = f.read()
        except Exception:
            return None
        m = re.search(r"docker[-/]([0-9a-f]{12,64})", content)
        if m:
            return m.group(1)[:12]
        return None

    @staticmethod
    def _firewall() -> Dict[str, Any]:
        """État réel du filtrage entrant.

        Nuance qui compte : Docker installe toujours des règles iptables pour son
        propre routage. Leur présence ne veut donc **pas** dire qu'un pare-feu
        protège la machine. Le critère retenu est la politique par défaut de la
        chaîne INPUT — si elle accepte tout, rien ne filtre, quoi qu'il y ait
        d'autre dans les tables.
        """
        res = host.run("ufw", ["status"], timeout=10)
        if res.ok and res.out:
            active = "Status: active" in res.stdout or "Statut : actif" in res.stdout
            return {
                "active": active,
                "backend": "ufw",
                "detail": "ufw actif" if active else "ufw installé mais désactivé",
            }

        res = host.run("nft", ["list", "ruleset"], timeout=10)
        if res.ok:
            hooks = re.findall(
                r"type filter hook input[^;]*policy\s+(\w+)", res.stdout)
            if hooks:
                blocking = [p for p in hooks if p.lower() in ("drop", "reject")]
                if blocking:
                    return {"active": True, "backend": "nftables",
                            "detail": f"politique d'entrée : {blocking[0]}"}
                return {
                    "active": False, "backend": "nftables",
                    "detail": "règles présentes, mais la politique d'entrée accepte tout "
                              "(les tables existantes sont celles de Docker)",
                }
            return {"active": False, "backend": "nftables",
                    "detail": "aucune chaîne de filtrage en entrée"}

        if not host.available():
            return {"active": None, "backend": None,
                    "detail": "état non vérifiable (pas d'accès à l'hôte)"}

        return {
            "active": False,
            "backend": None,
            "detail": "Aucun pare-feu configuré : toutes les connexions entrantes sont acceptées.",
        }

    @staticmethod
    def _ping_target(target: Optional[str]) -> Dict[str, Any]:
        if not target:
            return {"ip": None, "pingMs": None}
        try:
            p = subprocess.run(
                ["ping", "-c", "1", "-W", "1", "-n", target],
                capture_output=True, text=True, timeout=3, check=False,
            )
            m = re.search(r"time=([\d.]+)\s*ms", p.stdout)
            if m:
                return {"ip": target, "target": target, "pingMs": round(float(m.group(1)), 2)}
        except Exception:
            pass
        return {"ip": target, "target": target, "pingMs": None}

    # -------------------------------------------------------------- processus

    def get_processes(self) -> Dict[str, Any]:
        procs: List[Dict[str, Any]] = []
        zombies = 0
        threads_total = 0

        fields = ["pid", "ppid", "username", "name", "cmdline", "cpu_percent",
                  "memory_percent", "memory_info", "num_threads", "nice",
                  "status", "create_time"]

        for p in psutil.process_iter(fields):
            try:
                i = p.info
            except Exception:
                continue

            status = i.get("status") or "sleeping"
            if status == psutil.STATUS_ZOMBIE:
                zombies += 1
            threads_total += i.get("num_threads") or 0

            cmdline = i.get("cmdline") or []
            cmd = " ".join(cmdline) if cmdline else (i.get("name") or "")

            procs.append({
                "pid": i["pid"],
                "ppid": i.get("ppid") or 0,
                "user": i.get("username") or "?",
                "cmd": cmd[:200] or (i.get("name") or "?"),
                "cpuPct": round(i.get("cpu_percent") or 0, 1),
                "memPct": round(i.get("memory_percent") or 0, 2),
                "rssMiB": round(i["memory_info"].rss / (1024 ** 2)) if i.get("memory_info") else 0,
                "threads": i.get("num_threads") or 0,
                "nice": i.get("nice") if i.get("nice") is not None else 0,
                "state": {
                    psutil.STATUS_RUNNING: "R",
                    psutil.STATUS_SLEEPING: "S",
                    psutil.STATUS_DISK_SLEEP: "D",
                    psutil.STATUS_ZOMBIE: "Z",
                }.get(status, "S"),
                "startedAt": _iso(i.get("create_time")),
                "containerId": self._container_of(i["pid"]),
            })

        procs.sort(key=lambda x: x["cpuPct"], reverse=True)

        return {
            "summary": {
                "count": len(procs),
                "threads": threads_total,
                "zombies": zombies,
                "loadavg": [round(x, 2) for x in os.getloadavg()],
            },
            "processes": procs[:300],
        }

    # ----------------------------------------------------------------- système

    def get_system(self, audit=None) -> Dict[str, Any]:
        os_name = "inconnu"
        for candidate in ("/etc/os-release", hw.host_path("/etc/os-release")):
            try:
                with open(candidate, "r") as f:
                    for line in f:
                        if line.startswith("PRETTY_NAME="):
                            os_name = line.split("=", 1)[1].strip().strip('"')
                            break
                if os_name != "inconnu":
                    break
            except Exception:
                continue

        # Une simulation apt coûte ~0,5 s sur l'hôte ; les mises à jour disponibles
        # ne changent qu'au rythme des `apt update`. Dix minutes suffisent.
        pending, security = self._slow.get("updates", 600, self._pending_updates)

        return {
            "os": os_name,
            "kernel": platform.uname().release,
            "hostname": platform.node(),
            "bootedAt": _iso(self.boot_time),
            "uptimeSeconds": int(time.time() - self.boot_time),
            "needsReboot": hw.reboot_required(),
            "pendingUpdates": pending,
            "securityUpdates": security,
            "hostControl": host.available(),
            "services": self._services(),
            "recentActions": audit.recent_system_actions(10) if audit else [],
        }

    # Services considérés comme critiques, donc affichés. Le démon docker et les
    # stacks déclarées hors périmètre dans `config/owners.yaml` n'y figurent pas
    # (règle §5 de wopr-server-rules.md).
    WATCHED_SERVICES = [
        ("docker.service", "Démon Docker", False),
        ("ssh.service", "Serveur SSH", True),
        ("systemd-networkd.service", "Réseau (systemd-networkd)", True),
        ("systemd-resolved.service", "Résolution DNS", True),
        ("nvidia-persistenced.service", "Persistance pilote NVIDIA", True),
        ("cron.service", "Tâches planifiées", True),
    ]

    def _services(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not host.available():
            return out

        names = [n for n, _, _ in self.WATCHED_SERVICES]
        res = host.run("systemctl", ["show", "--property=Id,ActiveState,LoadState,Description", *names])
        if not res.ok:
            return out

        blocks = [b for b in res.stdout.split("\n\n") if b.strip()]
        parsed: Dict[str, Dict[str, str]] = {}
        for block in blocks:
            kv = dict(
                line.split("=", 1) for line in block.strip().splitlines() if "=" in line
            )
            if "Id" in kv:
                parsed[kv["Id"]] = kv

        for name, label, restartable in self.WATCHED_SERVICES:
            kv = parsed.get(name)
            if not kv or kv.get("LoadState") == "not-found":
                continue
            active = kv.get("ActiveState", "inactive")
            out.append({
                "name": name,
                "state": "active" if active == "active" else ("failed" if active == "failed" else "inactive"),
                "restartable": restartable,
                "description": label,
            })
        return out

    @staticmethod
    def _pending_updates() -> Tuple[Optional[int], Optional[int]]:
        """Mises à jour en attente.

        `apt-check` d'update-notifier n'est pas installé sur cette machine ; on
        interroge apt en simulation. Si rien n'est exploitable, on renvoie None
        plutôt que zéro — « je ne sais pas » n'est pas « tout est à jour ».
        """
        res = host.run("apt-check", ["--human-readable"], timeout=30)
        if res.ok and ";" in res.out:
            try:
                total, sec = res.out.split(";")[:2]
                return int(total), int(sec)
            except ValueError:
                pass

        # Sans `apt-check`, on simule une mise à niveau. Le passage par l'hôte est
        # indispensable : depuis le conteneur, apt-get compterait les paquets de
        # l'image Python, pas ceux d'Ubuntu.
        res = host.run("apt-get", ["upgrade", "-s", "-o", "Debug::NoLocking=1"], timeout=60)
        if res.ok:
            total = len(re.findall(r"^Inst ", res.stdout, re.M))
            security = len(re.findall(r"^Inst .*-security", res.stdout, re.M))
            return total, security
        return None, None
