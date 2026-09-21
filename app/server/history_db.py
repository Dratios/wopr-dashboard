"""Historique longue durée des métriques, dans PostgreSQL.

L'historique en mémoire de `collector.py` ne couvre que quelques minutes : il sert
aux variations et aux mini-courbes. Celui-ci alimente les graphes de 1 min à 6 h.
Chaque échantillon de 5 s y est écrit, une ligne par métrique.

La base est facultative : si elle ne répond pas, le dashboard fonctionne comme
avant et les graphes retombent sur l'historique en mémoire. C'est pourquoi les
écritures passent par une file et un thread à part : une base lente ou arrêtée ne
doit jamais retarder l'échantillonnage.
"""

from __future__ import annotations

import logging
import math
import os
import queue
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from . import settings

log = logging.getLogger("wopr.history")

# Fenêtres proposées par les graphes, en secondes.
RANGES: Dict[str, int] = {"1m": 60, "5m": 300, "1h": 3600, "6h": 21600}

SAMPLE_INTERVAL_S = 5
# Au-delà, un graphe de 700 unités de large n'affiche rien de plus : on moyenne
# côté base plutôt que d'envoyer 4 320 points par courbe pour 6 h.
TARGET_POINTS = 360
# Repli ; la valeur effective vient de l'onglet Paramètres.
RETENTION_H = 24
PURGE_EVERY_S = 600
# Une heure d'échantillons en attente si la base est arrêtée ; au-delà, les plus
# anciens sont abandonnés plutôt que de faire grossir la mémoire sans limite.
MAX_PENDING = 720

def _retention_h() -> int:
    try:
        return int(settings.get("collect.historyRetentionH"))
    except Exception:
        return RETENTION_H


SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    metric text             NOT NULL,
    ts     timestamptz      NOT NULL,
    value  double precision NOT NULL,
    PRIMARY KEY (metric, ts)
);
-- Les lignes arrivent dans l'ordre chronologique : un index BRIN, minuscule,
-- suffit à la purge par date.
CREATE INDEX IF NOT EXISTS samples_ts_brin ON samples USING brin (ts);
"""


class HistoryUnavailable(Exception):
    """La base ne répond pas ou n'est pas configurée ; le message est affichable."""


def step_seconds(range_s: int) -> int:
    """Largeur d'un point du graphe : 5 s jusqu'à 30 min, puis de quoi tenir en 360 points."""
    return max(SAMPLE_INTERVAL_S, range_s // TARGET_POINTS)


class HistoryStore:
    def __init__(self) -> None:
        self._params = {
            "host": os.environ.get("WOPR_DB_HOST", "127.0.0.1"),
            "port": int(os.environ.get("WOPR_DB_PORT", "5434")),
            "dbname": os.environ.get("WOPR_DB_NAME", "wopr_history"),
            "user": os.environ.get("WOPR_DB_USER", "wopr"),
            "password": os.environ.get("WOPR_DB_PASSWORD", ""),
            "connect_timeout": 3,
            "application_name": "wopr-dashboard",
        }
        self.enabled = bool(self._params["password"])
        self.available = False
        self.last_error: Optional[str] = None

        self._queue: "queue.Queue[Tuple[float, Dict[str, float]]]" = queue.Queue(maxsize=MAX_PENDING)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # Lectures sur leur propre connexion : une requête 6 h ne doit pas faire
        # attendre les écritures, ni l'inverse.
        self._read_conn = None
        self._read_lock = threading.Lock()

    # ------------------------------------------------------------- connexion

    def _connect(self):
        import psycopg  # import tardif : le module reste importable sans le pilote

        conn = psycopg.connect(autocommit=True, **self._params)
        return conn

    # --------------------------------------------------------------- écriture

    def record(self, ts: float, sample: Dict[str, float]) -> None:
        """Met un échantillon en file ; ne bloque jamais."""
        if not self.enabled:
            return
        try:
            self._queue.put_nowait((ts, sample))
        except queue.Full:
            try:
                self._queue.get_nowait()      # abandonne le plus ancien
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait((ts, sample))
            except queue.Full:
                pass

    def start(self) -> None:
        if not self.enabled:
            log.warning("historique longue durée désactivé : WOPR_DB_PASSWORD absent")
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._writer_loop, name="wopr-history-db", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _writer_loop(self) -> None:
        conn = None
        backoff = 5.0
        last_purge = 0.0
        batch: List[Tuple[float, Dict[str, float]]] = []

        while not self._stop.is_set():
            # Attend un échantillon, puis ramasse ce qui s'est accumulé entre-temps.
            if not batch:
                try:
                    batch.append(self._queue.get(timeout=1.0))
                except queue.Empty:
                    continue
            while len(batch) < MAX_PENDING:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break

            try:
                if conn is None or conn.closed:
                    conn = self._connect()
                    conn.execute(SCHEMA)
                    if not self.available:
                        log.info("historique longue durée : base connectée")
                    self.available, self.last_error, backoff = True, None, 5.0

                rows = [
                    (metric, ts, float(value))
                    for ts, sample in batch
                    for metric, value in sample.items()
                    if value is not None and math.isfinite(float(value))
                ]
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO samples (metric, ts, value) VALUES (%s, to_timestamp(%s), %s) "
                        "ON CONFLICT DO NOTHING",
                        rows,
                    )
                batch = []

                if time.time() - last_purge > PURGE_EVERY_S:
                    conn.execute(
                        "DELETE FROM samples WHERE ts < now() - make_interval(hours => %s)",
                        (_retention_h(),),
                    )
                    last_purge = time.time()
            except Exception as exc:
                if self.available or self.last_error is None:
                    log.warning("historique longue durée : base injoignable (%s)", exc)
                self.available, self.last_error = False, str(exc).strip() or type(exc).__name__
                try:
                    if conn is not None:
                        conn.close()
                except Exception:
                    pass
                conn = None
                # Garde le lot pour le prochain essai, dans la limite de la file.
                batch = batch[-MAX_PENDING:]
                self._stop.wait(backoff)
                backoff = min(60.0, backoff * 2)

        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    # ---------------------------------------------------------------- lecture

    def query(self, range_key: str, metrics: List[str]) -> Dict[str, Any]:
        """Moyennes par pas régulier sur la fenêtre, `None` là où rien n'a été mesuré."""
        if not self.enabled:
            raise HistoryUnavailable("historique désactivé : WOPR_DB_PASSWORD absent du .env")

        range_s = RANGES[range_key]
        step = step_seconds(range_s)
        count = range_s // step
        # Grille alignée sur le pas : les points ne « glissent » pas d'un
        # rafraîchissement à l'autre, seul le dernier (en cours) évolue. Elle
        # s'arrête un échantillon avant l'instant présent : au pas de 5 s, le
        # créneau en cours n'a le plus souvent pas encore reçu sa mesure, et la
        # courbe finirait sur un trou.
        last = math.floor((time.time() - SAMPLE_INTERVAL_S) / step) * step
        first = last - (count - 1) * step

        with self._read_lock:
            try:
                if self._read_conn is None or self._read_conn.closed:
                    self._read_conn = self._connect()
                rows = self._read_conn.execute(
                    "SELECT metric, floor(extract(epoch FROM ts) / %(step)s)::bigint * %(step)s AS b, "
                    "avg(value) FROM samples "
                    "WHERE metric = ANY(%(metrics)s) AND ts >= to_timestamp(%(first)s) "
                    "GROUP BY 1, 2",
                    {"step": step, "metrics": metrics, "first": first},
                ).fetchall()
            except Exception as exc:
                try:
                    if self._read_conn is not None:
                        self._read_conn.close()
                except Exception:
                    pass
                self._read_conn = None
                raise HistoryUnavailable(f"base d'historique injoignable ({str(exc).strip() or type(exc).__name__})")

        index = {m: [None] * count for m in metrics}
        for metric, bucket, value in rows:
            i = (int(bucket) - first) // step
            if 0 <= i < count and metric in index:
                index[metric][i] = round(float(value), 2)

        return {
            "range": range_key,
            "stepSeconds": step,
            "timestamps": [first + i * step for i in range(count)],
            "series": index,
        }


history_db = HistoryStore()
