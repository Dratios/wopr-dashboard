"""Écriture partagée de `data/state.json`.

Trois modules y rangent leur état (alertes, ventilateurs, mode actif), chacun
sous sa propre clé. Chacun relisait le fichier, remplaçait sa clé et le réécrivait
en entier, depuis des threads différents : deux écritures simultanées pouvaient
effacer la mise à jour de l'autre — un préréglage de ventilation ou un
acquittement perdu sans bruit. Le verrou unique ci-dessous sérialise ces
lecture-modification-écriture.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict

log = logging.getLogger("wopr.state")

_lock = threading.Lock()


def load_section(path: str, key: str) -> Dict[str, Any]:
    """Section `key` du fichier d'état, ou `{}` s'il est absent ou illisible."""
    with _lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                value = json.load(f).get(key)
        except Exception:
            return {}
    return value if isinstance(value, dict) else {}


def save_section(path: str, key: str, value: Any) -> None:
    """Remplace la section `key` sans toucher aux autres, de façon atomique."""
    with _lock:
        try:
            blob: Dict[str, Any] = {}
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    blob = json.load(f)
            blob[key] = value
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(blob, f, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except Exception:
            log.exception("sauvegarde de la section « %s » de l'état impossible", key)
