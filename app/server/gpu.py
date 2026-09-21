"""GPU NVIDIA (via NVML) et moteurs de modèles (Ollama).

Tout est **énuméré à chaud** : le nombre de cartes, leurs plages de power limit,
leur mode de refroidissement. Aucune carte n'est écrite en dur. Conséquence voulue :
le jour où la Tesla P100 est montée dans la machine, elle apparaît dans l'interface
après un simple redémarrage du conteneur, sans toucher au code.

Deux détails qui comptent pour une carte passive comme la P100 :
- NVML ne rapporte pas de ventilateur → `fanPct` vaut `None`, et l'UI doit afficher
  « refroidissement châssis », pas « 0 % ».
- Sa plage de power limit lui est propre : elle est lue par carte, jamais déduite
  en pourcentage de celle d'une autre.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

import requests

from . import settings

log = logging.getLogger("wopr.gpu")


def ollama_url() -> str:
    return str(settings.get("general.ollamaUrl")).rstrip("/")


def ollama_timeout() -> float:
    return float(settings.get("general.ollamaTimeoutS"))

try:
    import pynvml
    _NVML_IMPORTED = True
except Exception:  # pragma: no cover
    pynvml = None  # type: ignore
    _NVML_IMPORTED = False


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value) if value is not None else ""


class GpuManager:
    def __init__(self) -> None:
        self.ready = False
        self.error: Optional[str] = None
        self.driver = ""
        self._init_nvml()

    def _init_nvml(self) -> None:
        if not _NVML_IMPORTED:
            self.error = "pynvml n'est pas installé dans l'image"
            return
        try:
            pynvml.nvmlInit()
            self.driver = _text(pynvml.nvmlSystemGetDriverVersion())
            self.ready = True
            count = pynvml.nvmlDeviceGetCount()
            log.info("NVML initialisé — pilote %s, %d carte(s) détectée(s)", self.driver, count)
        except Exception as exc:
            self.error = f"NVML indisponible : {exc}"
            log.warning(self.error)

    def _handles(self) -> List[Any]:
        if not self.ready:
            return []
        try:
            return [pynvml.nvmlDeviceGetHandleByIndex(i)
                    for i in range(pynvml.nvmlDeviceGetCount())]
        except Exception:
            return []

    # ------------------------------------------------------------------ lecture

    def average_utilisation(self) -> Optional[float]:
        cards = self.read_cards()
        if not cards:
            return None
        return round(sum(c["utilPct"] for c in cards) / len(cards), 1)

    def read_cards(self) -> List[Dict[str, Any]]:
        cards: List[Dict[str, Any]] = []
        for index, handle in enumerate(self._handles()):
            try:
                cards.append(self._read_card(index, handle))
            except Exception:
                log.exception("lecture de la carte %d impossible", index)
        return cards

    def _read_card(self, index: int, handle: Any) -> Dict[str, Any]:
        def attempt(fn, default=None):
            try:
                return fn()
            except Exception:
                return default

        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        util = attempt(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle).gpu, 0)
        mem_util = attempt(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle).memory, 0)

        # Ventilateur : absent sur une carte passive. `None`, jamais 0.
        fan_pct = attempt(lambda: pynvml.nvmlDeviceGetFanSpeed(handle))

        power = attempt(lambda: round(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000))
        limit = attempt(lambda: round(pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000))

        # Plage propre à cette carte, lue et non déduite.
        constraints = attempt(
            lambda: pynvml.nvmlDeviceGetPowerManagementLimitConstraints(handle)
        )
        if constraints:
            limit_range = [round(constraints[0] / 1000), round(constraints[1] / 1000)]
        else:
            limit_range = None

        pcie_gen = attempt(lambda: pynvml.nvmlDeviceGetCurrPcieLinkGeneration(handle))
        pcie_width = attempt(lambda: pynvml.nvmlDeviceGetCurrPcieLinkWidth(handle))
        pcie = f"PCIe {pcie_gen}.0 x{pcie_width}" if pcie_gen and pcie_width else None

        ecc = None
        try:
            corrected = pynvml.nvmlDeviceGetTotalEccErrors(
                handle, pynvml.NVML_MEMORY_ERROR_TYPE_CORRECTED,
                pynvml.NVML_VOLATILE_ECC)
            uncorrected = pynvml.nvmlDeviceGetTotalEccErrors(
                handle, pynvml.NVML_MEMORY_ERROR_TYPE_UNCORRECTED,
                pynvml.NVML_VOLATILE_ECC)
            ecc = {"corrected": corrected, "uncorrected": uncorrected}
        except Exception:
            ecc = None  # carte grand public sans ECC

        processes = []
        for getter in (
            getattr(pynvml, "nvmlDeviceGetComputeRunningProcesses_v3", None),
            pynvml.nvmlDeviceGetComputeRunningProcesses,
        ):
            if getter is None:
                continue
            try:
                for p in getter(handle):
                    processes.append({
                        "pid": p.pid,
                        "name": self._process_name(p.pid),
                        "type": "C",
                        "memMiB": round(p.usedGpuMemory / (1024 ** 2))
                        if p.usedGpuMemory else 0,
                    })
                break
            except Exception:
                continue

        display_active = attempt(lambda: pynvml.nvmlDeviceGetDisplayMode(handle) == 1)

        return {
            "index": index,
            "name": _text(pynvml.nvmlDeviceGetName(handle)),
            "uuid": _text(attempt(lambda: pynvml.nvmlDeviceGetUUID(handle), "")),
            "memTotalMiB": round(mem.total / (1024 ** 2)),
            "memUsedMiB": round(mem.used / (1024 ** 2)),
            "memUtilPct": mem_util,
            "utilPct": util,
            "tempC": attempt(lambda: pynvml.nvmlDeviceGetTemperature(
                handle, pynvml.NVML_TEMPERATURE_GPU)),
            "fanPct": fan_pct,
            "fanRpm": None,  # NVML ne donne pas de tr/min, seulement un pourcentage
            "cooling": "active" if fan_pct is not None else "chassis",
            "powerW": power,
            "powerLimitW": limit,
            "powerLimitRangeW": limit_range,
            "clockSmMhz": attempt(lambda: pynvml.nvmlDeviceGetClockInfo(
                handle, pynvml.NVML_CLOCK_SM)),
            "clockMemMhz": attempt(lambda: pynvml.nvmlDeviceGetClockInfo(
                handle, pynvml.NVML_CLOCK_MEM)),
            "pcie": pcie,
            "hasDisplayOut": bool(display_active),
            "driver": self.driver,
            "vbios": _text(attempt(lambda: pynvml.nvmlDeviceGetVbiosVersion(handle), "")),
            "ecc": ecc,
            "processes": processes,
            "history": [],
        }

    @staticmethod
    def _process_name(pid: int) -> str:
        try:
            import psutil
            return psutil.Process(pid).name()
        except Exception:
            return "?"

    # ------------------------------------------------------------------ actions

    def set_power_limit(self, index: int, watts: int) -> tuple[bool, str]:
        handles = self._handles()
        if index >= len(handles):
            return False, f"carte {index} inexistante"
        handle = handles[index]
        try:
            lo, hi = pynvml.nvmlDeviceGetPowerManagementLimitConstraints(handle)
            lo_w, hi_w = round(lo / 1000), round(hi / 1000)
        except Exception:
            return False, "plage de power limit illisible sur cette carte"

        if not (lo_w <= watts <= hi_w):
            return False, f"valeur hors plage pour cette carte ({lo_w}–{hi_w} W)"

        try:
            pynvml.nvmlDeviceSetPowerManagementLimit(handle, int(watts * 1000))
            return True, f"{watts} W"
        except Exception as exc:
            return False, f"NVML a refusé : {exc}"

    # ------------------------------------------------------------------ Ollama

    def _ollama(self, path: str, method: str = "GET", payload: Optional[dict] = None,
                timeout: Optional[float] = None) -> Optional[Any]:
        # Adresse et délai relus à chaque appel : l'onglet Paramètres les change
        # sans redémarrage.
        base = ollama_url()
        timeout = ollama_timeout() if timeout is None else timeout
        try:
            if method == "GET":
                r = requests.get(f"{base}{path}", timeout=timeout)
            else:
                r = requests.post(f"{base}{path}", json=payload, timeout=timeout)
            if r.status_code >= 400:
                log.warning("Ollama %s %s → %s", method, path, r.status_code)
                return None
            return r.json()
        except Exception:
            return None

    def ollama_reachable(self) -> bool:
        return self._ollama("/api/tags") is not None

    def loaded_models(self, cards: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        data = self._ollama("/api/ps")
        if data is None:
            return []

        # Cartes portant au moins un processus Ollama : c'est la seule attribution
        # modèle → GPU que l'on peut établir honnêtement.
        ollama_gpus = [
            c["index"] for c in cards
            if any("ollama" in p["name"].lower() for p in c["processes"])
        ]

        models = data.get("models", []) or []
        out: List[Dict[str, Any]] = []
        for m in models:
            details = m.get("details") or {}
            expires = m.get("expires_at")
            pinned = self._is_pinned(expires)

            vram_mib = round((m.get("size_vram") or 0) / (1024 ** 2))

            # Répartition par carte : dérivable uniquement si un seul modèle est
            # résident. Sinon on ne peut pas dire quelle carte porte quoi, et on
            # préfère ne rien affirmer.
            per_gpu: Optional[Dict[str, int]] = None
            if len(models) == 1 and ollama_gpus:
                per_gpu = {}
                for c in cards:
                    mib = sum(p["memMiB"] for p in c["processes"]
                              if "ollama" in p["name"].lower())
                    if mib:
                        per_gpu[str(c["index"])] = mib

            out.append({
                "id": m.get("digest", m.get("name", "?"))[:12],
                "name": m.get("name") or m.get("model") or "?",
                "engine": "ollama",
                "gpus": ollama_gpus,
                "vramMiB": vram_mib,
                "vramPerGpuMiB": per_gpu,
                "sizeMiB": round((m.get("size") or 0) / (1024 ** 2)),
                "contextTokens": details.get("context_length"),
                "quant": details.get("quantization_level") or "?",
                "parameterSize": details.get("parameter_size") or "",
                # Ollama n'expose pas de débit de génération : ne rien inventer.
                "tokensPerSec": None,
                "loadedAt": None,
                "lastUsedAt": None,
                "expiresAt": expires,
                "state": "active",
                "pinned": pinned,
            })
        return out

    @staticmethod
    def _is_pinned(expires_at: Optional[str]) -> bool:
        """`keep_alive: -1` se traduit par une date d'expiration très lointaine.

        Ollama ajoute la durée maximale de Go (~292 ans) à l'heure courante : la
        date renvoyée tombe vers l'an 2318. L'ancien test (« année > 9999 ») n'était
        donc jamais vrai et un modèle épinglé apparaissait comme non épinglé.
        """
        if not expires_at:
            return False
        try:
            year = int(str(expires_at)[:4])
            return year >= time.gmtime().tm_year + 100
        except Exception:
            return False

    def available_models(self, data: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        if data is None:
            data = self._ollama("/api/tags")
        if data is None:
            return []
        out = []
        for m in data.get("models", []) or []:
            details = m.get("details") or {}
            out.append({
                "name": m.get("name") or "?",
                "sizeGiB": round((m.get("size") or 0) / (1024 ** 3), 2),
                "quant": details.get("quantization_level") or "?",
                "parameterSize": details.get("parameter_size") or "",
                "family": details.get("family") or "",
            })
        return sorted(out, key=lambda x: x["name"])

    def load_model(self, name: str, keep_alive: Any = "5m") -> tuple[bool, str]:
        """Charge un modèle en VRAM sans générer de texte (prompt vide)."""
        res = self._ollama(
            "/api/generate", "POST",
            {"model": name, "prompt": "", "keep_alive": keep_alive},
            timeout=120.0,
        )
        if res is None:
            return False, "Ollama injoignable ou modèle inconnu"
        return True, name

    def unload_model(self, name: str) -> tuple[bool, str]:
        """`keep_alive: 0` demande à Ollama de libérer la VRAM immédiatement."""
        res = self._ollama(
            "/api/generate", "POST",
            {"model": name, "prompt": "", "keep_alive": 0},
            timeout=30.0,
        )
        if res is None:
            return False, "Ollama injoignable"
        return True, name

    def pin_model(self, name: str, pinned: bool) -> tuple[bool, str]:
        """Épingler = `keep_alive: -1` (jamais déchargé automatiquement)."""
        return self.load_model(name, keep_alive=-1 if pinned else "5m")

    # ---------------------------------------------------------------- agrégat

    def get_gpu_data(self) -> Dict[str, Any]:
        cards = self.read_cards()
        models = self.loaded_models(cards)

        vram_used = sum(c["memUsedMiB"] for c in cards)
        vram_total = sum(c["memTotalMiB"] for c in cards)
        powers = [c["powerW"] for c in cards if c["powerW"] is not None]
        limits = [c["powerLimitW"] for c in cards if c["powerLimitW"] is not None]

        if vram_total:
            ratio = vram_used / vram_total
            pressure = "ok" if ratio < 0.75 else ("tendu" if ratio < 0.92 else "saturé")
        else:
            pressure = "ok"

        tags = self._ollama("/api/tags")
        version = self._ollama("/api/version") if tags is not None else None

        return {
            "available": self.ready,
            "unavailableReason": self.error,
            "ollamaReachable": tags is not None,
            "ollamaVersion": (version or {}).get("version"),
            "aggregate": {
                "count": len(cards),
                "vramUsedMiB": vram_used,
                "vramTotalMiB": vram_total,
                "utilAvgPct": round(sum(c["utilPct"] for c in cards) / len(cards), 1) if cards else 0,
                "powerW": sum(powers) if powers else None,
                "powerLimitW": sum(limits) if limits else None,
                "modelsLoaded": len(models),
                "gpuProcesses": sum(len(c["processes"]) for c in cards),
                "pressure": pressure,
            },
            "gpus": cards,
            "models": models,
            "availableModels": self.available_models(tags) if tags is not None else [],
        }


gpu_manager = GpuManager()
