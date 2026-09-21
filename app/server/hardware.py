"""Accès bas niveau au matériel de l'hôte depuis le conteneur.

Sépare le « comment on lit » du « quoi on expose » (collector.py). Regroupe les
particularités de cette machine découvertes à l'installation :

- Le conteneur tourne en `pid: host` et `network_mode: host`, donc `/proc` et les
  compteurs réseau sont déjà ceux de l'hôte. En revanche le *namespace de montage*
  reste celui du conteneur : les montages réels se lisent dans `/proc/1/mounts`, et
  l'occupation disque via le bind-mount lecture seule de la racine hôte.
- Le Super I/O est un Nuvoton **nct6799** (ASUS TUF GAMING B650-PLUS WIFI). Le module
  `nct6775` l'expose, mais plusieurs de ses entrées ne sont reliées à rien et
  renvoient des valeurs aberrantes — elles sont filtrées ici, pas affichées.
- La puissance CPU vient de RAPL (`/sys/class/powercap`) quand il est présent ;
  sinon la valeur est marquée comme estimée et l'UI le dit.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("wopr.hardware")

HOST_ROOT = os.environ.get("WOPR_HOST_ROOT", "/host/root")
SYS = "/sys"

# Entrées du nct6799 non reliées sur cette carte : elles renvoient 0 °C, 5 °C, 12 °C…
# Les afficher reviendrait à inventer des capteurs. On ne montre que ce qu'on sait nommer.
UNCONNECTED_SENSOR_PATTERNS = (
    re.compile(r"^AUXTIN\d*$", re.I),
    re.compile(r"^PCH_", re.I),
    re.compile(r"^SMBUSMASTER", re.I),
    re.compile(r"^Sensor \d+$", re.I),  # libellés génériques sans signification
)

# Plage de température physiquement plausible pour un capteur de PC.
PLAUSIBLE_TEMP_RANGE = (10.0, 125.0)

# Libellés lisibles pour les capteurs qu'on garde.
SENSOR_LABELS = {
    ("k10temp", "Tctl"): "CPU — Tctl (package)",
    ("k10temp", "Tccd1"): "CPU — Tccd1 (die)",
    ("nct6799", "SYSTIN"): "Carte mère — System",
    ("nct6799", "CPUTIN"): "Carte mère — CPU socket",
    ("nct6799", "TSI0_TEMP"): "Carte mère — TSI0 (CPU)",
    ("nct6799", "PECI/TSI Agent 0 Calibration"): "Carte mère — PECI agent 0",
    ("amdgpu", "edge"): "iGPU AMD — edge",
    ("r8169_0_800:00", ""): "Contrôleur réseau (r8169)",
}

# Seuils par type de capteur (warn, crit), en °C.
SENSOR_THRESHOLDS = {
    "k10temp": (85, 95),
    "nvme": (70, 80),
    "amdgpu": (90, 100),
    "nct6799": (80, 95),
    "spd5118": (65, 85),
    "r8169_0_800:00": (100, 115),
}
DEFAULT_THRESHOLDS = (80, 95)


def _read(path: str) -> Optional[str]:
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except Exception:
        return None


def _read_int(path: str) -> Optional[int]:
    v = _read(path)
    if v is None:
        return None
    try:
        return int(v)
    except ValueError:
        return None


def _write(path: str, value: str) -> bool:
    try:
        with open(path, "w") as f:
            f.write(value)
        return True
    except Exception as exc:
        log.warning("écriture refusée sur %s : %s", path, exc)
        return False


def host_path(path: str) -> str:
    """Traduit un chemin de l'hôte vers sa vue depuis le conteneur."""
    if os.path.isdir(HOST_ROOT):
        return os.path.join(HOST_ROOT, path.lstrip("/"))
    return path


# --------------------------------------------------------------------------- DMI


def dmi() -> Dict[str, str]:
    base = f"{SYS}/class/dmi/id"
    return {
        "board": _read(f"{base}/board_name") or "inconnue",
        "vendor": _read(f"{base}/board_vendor") or "",
        "biosVersion": _read(f"{base}/bios_version") or "",
        "biosDate": _read(f"{base}/bios_date") or "",
    }


# ------------------------------------------------------------------------- hwmon


class HwmonChip:
    def __init__(self, path: str) -> None:
        self.path = path
        self.name = _read(os.path.join(path, "name")) or os.path.basename(path)

    def _label(self, prefix: str, idx: int) -> str:
        return _read(os.path.join(self.path, f"{prefix}{idx}_label")) or ""

    def temps(self) -> List[Tuple[str, float]]:
        """(libellé brut, °C) des capteurs plausibles et identifiables."""
        out: List[Tuple[str, float]] = []
        for f in sorted(glob.glob(os.path.join(self.path, "temp*_input"))):
            m = re.search(r"temp(\d+)_input$", f)
            if not m:
                continue
            idx = int(m.group(1))
            raw = _read_int(f)
            if raw is None:
                continue
            celsius = raw / 1000.0
            label = self._label("temp", idx)

            if any(p.match(label) for p in UNCONNECTED_SENSOR_PATTERNS):
                continue
            lo, hi = PLAUSIBLE_TEMP_RANGE
            if not (lo <= celsius <= hi):
                # Entrée non reliée : ne rien afficher plutôt qu'un chiffre faux.
                continue
            out.append((label, celsius))
        return out

    def voltages(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for f in sorted(glob.glob(os.path.join(self.path, "in*_input"))):
            m = re.search(r"in(\d+)_input$", f)
            if not m:
                continue
            idx = int(m.group(1))
            raw = _read_int(f)
            if raw is None:
                continue
            label = self._label("in", idx)
            if not label or any(p.match(label) for p in UNCONNECTED_SENSOR_PATTERNS):
                continue
            volts = raw / 1000.0
            vmin = _read_int(os.path.join(self.path, f"in{idx}_min"))
            vmax = _read_int(os.path.join(self.path, f"in{idx}_max"))
            if vmin is not None and vmax is not None and vmax > 0:
                vrange = [round(vmin / 1000.0, 3), round(vmax / 1000.0, 3)]
                ok = vrange[0] <= volts <= vrange[1]
            else:
                # Sans bornes déclarées par le chip, on ne peut pas juger : on
                # affiche la mesure sans prétendre savoir si elle est correcte.
                # (L'ancienne version renvoyait la mesure comme « cible » et `ok`.)
                vrange = None
                ok = None
            out.append({"name": label, "value": round(volts, 3),
                        "range": vrange, "ok": ok})
        return out

    def fans(self) -> List[Dict[str, Any]]:
        """Ventilateurs du chip, headers vides exclus.

        Un header sans ventilateur branché rapporte 0 tr/min alors que son PWM est
        à fond. L'afficher « en panne » serait une fausse alerte : on l'omet.
        """
        out: List[Dict[str, Any]] = []
        for f in sorted(glob.glob(os.path.join(self.path, "fan*_input"))):
            m = re.search(r"fan(\d+)_input$", f)
            if not m:
                continue
            idx = int(m.group(1))
            rpm = _read_int(f)
            if rpm is None:
                continue

            pwm_path = os.path.join(self.path, f"pwm{idx}")
            enable_path = f"{pwm_path}_enable"
            pwm_raw = _read_int(pwm_path)
            enable = _read_int(enable_path)
            duty = round(pwm_raw / 255 * 100) if pwm_raw is not None else 0

            controllable = pwm_raw is not None and os.path.exists(enable_path)

            # Deux formes de header vide, toutes deux à masquer plutôt qu'à
            # présenter comme un ventilateur en panne :
            #   - on demande du régime et rien ne tourne (prise non branchée) ;
            #   - le header n'a même pas de sortie PWM et ne mesure rien.
            if rpm == 0 and (duty >= 90 or not controllable):
                continue

            # nct6775 : 1 = manuel, 2..4 = courbes du chip, 5 = Smart Fan IV.
            if enable == 1:
                mode = "manual"
            elif enable in (2, 3, 4):
                mode = "curve"
            else:
                mode = "auto"

            out.append({
                "index": idx,
                "chip": self.name,
                "rpm": rpm,
                "dutyPct": duty,
                "mode": mode,
                "controllable": controllable,
                "pwmPath": pwm_path,
                "enablePath": enable_path,
                "enableValue": enable,
                # Un ventilateur qui ne tourne plus alors qu'on lui demande du
                # régime : là, c'est une vraie panne.
                "fault": "stall" if (rpm == 0 and 0 < duty < 90) else None,
            })
        return out


def hwmon_chips() -> List[HwmonChip]:
    paths = glob.glob(f"{SYS}/class/hwmon/hwmon*")
    return [HwmonChip(p) for p in sorted(paths, key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0))]


def sensor_label(chip: str, raw_label: str) -> str:
    named = SENSOR_LABELS.get((chip, raw_label))
    if named:
        return named
    if chip == "nvme":
        return f"SSD NVMe — {raw_label or 'composite'}"
    if chip == "spd5118":
        return "Barrette mémoire DDR5"
    if raw_label:
        return f"{chip} — {raw_label}"
    return chip


def sensor_thresholds(chip: str) -> Tuple[int, int]:
    return SENSOR_THRESHOLDS.get(chip, DEFAULT_THRESHOLDS)


# ----------------------------------------------------------------- contrôle ventilo


def set_fan_manual(pwm_path: str, enable_path: str, duty_pct: int) -> bool:
    """Passe un ventilateur en pilotage manuel à un rapport cyclique donné."""
    duty_pct = max(0, min(100, duty_pct))
    raw = round(duty_pct * 255 / 100)
    if not _write(enable_path, "1"):
        return False
    return _write(pwm_path, str(raw))


def set_fan_auto(enable_path: str) -> bool:
    """Rend la main au chip (Smart Fan IV).

    C'est le failsafe : appelé à l'arrêt du service et dès qu'une température
    dépasse son seuil critique, pour qu'un dashboard planté ne laisse jamais les
    ventilateurs bloqués bas.
    """
    return _write(enable_path, "5")


# -------------------------------------------------------------------- CPU / RAPL


def cpu_governors() -> Dict[str, Any]:
    gov = _read(f"{SYS}/devices/system/cpu/cpu0/cpufreq/scaling_governor")
    available = (_read(f"{SYS}/devices/system/cpu/cpu0/cpufreq/scaling_available_governors") or "").split()
    epp = _read(f"{SYS}/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")
    epp_available = (_read(f"{SYS}/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences") or "").split()
    driver = _read(f"{SYS}/devices/system/cpu/cpu0/cpufreq/scaling_driver")
    return {
        "governor": gov,
        "available": available,
        "epp": epp,
        "eppAvailable": epp_available,
        "driver": driver,
    }


def set_cpu_governor(governor: str) -> Tuple[bool, str]:
    info = cpu_governors()
    if governor not in info["available"]:
        return False, f"gouverneur « {governor} » non supporté (disponibles : {', '.join(info['available']) or 'aucun'})"
    failed = []
    for path in sorted(glob.glob(f"{SYS}/devices/system/cpu/cpu*/cpufreq/scaling_governor")):
        if not _write(path, governor):
            failed.append(path)
    if failed:
        return False, f"écriture refusée sur {len(failed)} cœur(s)"
    return True, governor


def set_cpu_epp(preference: str) -> Tuple[bool, str]:
    info = cpu_governors()
    if preference not in info["eppAvailable"]:
        return False, f"préférence « {preference} » non supportée"
    failed = []
    for path in sorted(glob.glob(f"{SYS}/devices/system/cpu/cpu*/cpufreq/energy_performance_preference")):
        if not _write(path, preference):
            failed.append(path)
    if failed:
        return False, f"écriture refusée sur {len(failed)} cœur(s)"
    return True, preference


class RaplMeter:
    """Puissance CPU mesurée, dérivée du compteur d'énergie RAPL.

    RAPL expose une énergie cumulée en microjoules ; la puissance est sa dérivée.
    Le compteur boucle, d'où la gestion du dépassement.
    """

    def __init__(self) -> None:
        self.zones = self._discover()
        self._prev: Dict[str, Tuple[int, float]] = {}

    def _discover(self) -> Dict[str, Dict[str, Any]]:
        zones: Dict[str, Dict[str, Any]] = {}
        for zone in sorted(glob.glob(f"{SYS}/class/powercap/*/energy_uj")):
            d = os.path.dirname(zone)
            name = _read(os.path.join(d, "name")) or os.path.basename(d)
            if "package" not in name and "psys" not in name:
                continue
            max_range = _read_int(os.path.join(d, "max_energy_range_uj")) or 0
            zones[name] = {"path": zone, "max": max_range}
        return zones

    @property
    def available(self) -> bool:
        return bool(self.zones)

    def read_watts(self) -> Optional[float]:
        if not self.zones:
            return None
        now = time.time()
        total = 0.0
        measured = False
        for name, info in self.zones.items():
            micro = _read_int(info["path"])
            if micro is None:
                continue
            prev = self._prev.get(name)
            self._prev[name] = (micro, now)
            if prev is None:
                continue
            prev_micro, prev_time = prev
            dt = now - prev_time
            if dt <= 0:
                continue
            delta = micro - prev_micro
            if delta < 0:  # le compteur a bouclé
                delta += info["max"]
            total += (delta / 1_000_000.0) / dt
            measured = True
        return round(total, 1) if measured else None


# --------------------------------------------------------------------- montages


def host_mounts() -> List[Dict[str, str]]:
    """Montages réels de l'hôte, lus dans le namespace de PID 1.

    `psutil.disk_partitions()` renverrait les montages du conteneur.
    """
    ignored_fs = {
        "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2",
        "pstore", "bpf", "securityfs", "debugfs", "tracefs", "configfs",
        "fusectl", "hugetlbfs", "mqueue", "efivarfs", "autofs", "binfmt_misc",
        "squashfs", "overlay", "nsfs", "ramfs", "rpc_pipefs",
    }
    out: List[Dict[str, str]] = []
    seen = set()
    try:
        with open("/proc/1/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                device, mountpoint, fstype = parts[0], parts[1], parts[2]
                if fstype in ignored_fs:
                    continue
                mountpoint = mountpoint.replace("\\040", " ")
                if mountpoint in seen:
                    continue
                seen.add(mountpoint)
                out.append({"device": device, "path": mountpoint, "fs": fstype})
    except Exception:
        log.exception("lecture de /proc/1/mounts impossible")
    return out


def classify_device(device: str, fstype: str) -> str:
    """Nature physique du support derrière un montage.

    Un volume LVM pointe sur `/dev/dm-N`, dont le nom ne dit rien du disque : il
    faut remonter à ses `slaves` pour savoir si on est sur du NVMe ou du SATA.
    """
    if fstype.startswith("nfs") or ":" in device:
        return "nfs"
    if "nvme" in device:
        return "nvme"

    try:
        real = os.path.basename(os.path.realpath(device))
        if real.startswith("dm-"):
            slaves = os.listdir(f"{SYS}/block/{real}/slaves")
            if any("nvme" in s for s in slaves):
                return "nvme"
    except Exception:
        pass
    return "sata"


# ------------------------------------------------------------------- passerelle


def default_gateway() -> Optional[str]:
    """Passerelle par défaut, lue dans /proc/net/route (hexadécimal little-endian)."""
    try:
        with open("/proc/net/route", "r") as f:
            next(f)
            for line in f:
                fields = line.split()
                if len(fields) < 3:
                    continue
                if fields[1] == "00000000":  # destination 0.0.0.0
                    gw = int(fields[2], 16)
                    return ".".join(str((gw >> (8 * i)) & 0xFF) for i in range(4))
    except Exception:
        pass
    return None


def reboot_required() -> bool:
    return os.path.exists(host_path("/var/run/reboot-required")) or os.path.exists("/var/run/reboot-required")
