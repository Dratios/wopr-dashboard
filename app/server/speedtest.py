"""Test de débit réseau via l'infrastructure de mesure de Cloudflare.

Cible fixe et non paramétrable (`speed.cloudflare.com`) : un test dont la
cible serait choisie par l'appelant ouvrirait une sonde réseau arbitraire
(SSRF) depuis un conteneur qui a un accès réseau complet (`network_mode:
host`). Un verrou empêche deux tests simultanés (ça fausserait les deux
mesures et double la charge réseau), et un délai minimal entre deux tests
évite l'abus.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, Optional

import requests

from . import settings

log = logging.getLogger("wopr.speedtest")

_BASE = "https://speed.cloudflare.com"
# Plafond ; le test s'arrête avant si _MAX_SECONDS est atteint. Cloudflare
# refuse (403) les requêtes /__down demandant 100 Mio ou plus — constaté
# empiriquement, pas documenté ; on reste large en dessous.
_DOWNLOAD_BYTES = 50 * 1024 * 1024
_UPLOAD_BYTES = 20 * 1024 * 1024
_MAX_SECONDS = 8.0  # par phase (hors latence) : borne le temps total du test
_CHUNK = 256 * 1024

# Repli ; la valeur effective vient de l'onglet Paramètres.
MIN_INTERVAL_S = 20.0


def _min_interval_s() -> float:
    try:
        return float(settings.get("collect.speedtestMinIntervalS"))
    except Exception:
        return MIN_INTERVAL_S

_lock = threading.Lock()
_last_run_at = 0.0


class SpeedtestBusy(Exception):
    """Un test est déjà en cours."""


class SpeedtestTooSoon(Exception):
    """Le délai minimal entre deux tests n'est pas écoulé."""

    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after
        super().__init__(f"réessayer dans {retry_after:.0f} s")


def _measure_latency(samples: int = 6) -> Optional[float]:
    times = []
    for _ in range(samples):
        try:
            t0 = time.monotonic()
            requests.get(f"{_BASE}/__down?bytes=0", timeout=5)
            times.append((time.monotonic() - t0) * 1000)
        except Exception:
            continue
    if not times:
        return None
    times.sort()
    return round(times[len(times) // 2], 1)  # médiane : insensible aux pics isolés


def _measure_download() -> Optional[float]:
    try:
        t0 = time.monotonic()
        total = 0
        with requests.get(f"{_BASE}/__down?bytes={_DOWNLOAD_BYTES}",
                           stream=True, timeout=(5, _MAX_SECONDS + 5)) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_content(chunk_size=_CHUNK):
                total += len(chunk)
                if time.monotonic() - t0 >= _MAX_SECONDS:
                    break
        elapsed = time.monotonic() - t0
        if elapsed <= 0 or total == 0:
            return None
        return round((total * 8) / elapsed / 1_000_000, 1)
    except Exception:
        log.exception("mesure du débit descendant impossible")
        return None


def _measure_upload() -> Optional[float]:
    sent = {"bytes": 0}

    def gen(deadline: float):
        while time.monotonic() < deadline and sent["bytes"] < _UPLOAD_BYTES:
            chunk = os.urandom(_CHUNK)
            sent["bytes"] += len(chunk)
            yield chunk

    try:
        t0 = time.monotonic()
        resp = requests.post(f"{_BASE}/__up", data=gen(t0 + _MAX_SECONDS),
                              headers={"Content-Type": "application/octet-stream"},
                              timeout=(5, _MAX_SECONDS + 10))
        resp.raise_for_status()
        elapsed = time.monotonic() - t0
        if elapsed <= 0 or sent["bytes"] == 0:
            return None
        return round((sent["bytes"] * 8) / elapsed / 1_000_000, 1)
    except Exception:
        log.exception("mesure du débit montant impossible")
        return None


def run() -> Dict[str, Any]:
    """Lance latence puis descendant puis montant. Lève `SpeedtestBusy` /
    `SpeedtestTooSoon` sans rien mesurer si les garde-fous s'y opposent."""
    global _last_run_at
    if not _lock.acquire(blocking=False):
        raise SpeedtestBusy()
    try:
        remaining = _min_interval_s() - (time.monotonic() - _last_run_at)
        if _last_run_at and remaining > 0:
            raise SpeedtestTooSoon(remaining)

        latency = _measure_latency()
        download = _measure_download()
        upload = _measure_upload()
        _last_run_at = time.monotonic()

        return {
            "latencyMs": latency,
            "downloadMbps": download,
            "uploadMbps": upload,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    finally:
        _lock.release()
