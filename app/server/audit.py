"""Journal d'audit persistant.

Règle du serveur wopr (§6 de wopr-server-rules.md) : toute action mutante laisse une
trace — qui, quoi, quand, sur quoi, avec quel résultat. Le but est de pouvoir se
relire à deux, pas de surveiller qui que ce soit.

Stocké en SQLite dans `data/audit.db`, monté en volume : le journal survit aux
rebuilds de l'image.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("wopr.audit")

# Catégories reconnues par le frontend (cf. AuditLogItem dans types.ts).
CATEGORIES = {"mode", "docker", "system", "process", "llm", "alert", "fan"}
RESULTS = {"succès", "attention", "échec", "info"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT    NOT NULL,
    by       TEXT    NOT NULL,
    category TEXT    NOT NULL,
    target   TEXT    NOT NULL,
    detail   TEXT    NOT NULL,
    result   TEXT    NOT NULL,
    params   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at       ON audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit(category);
CREATE INDEX IF NOT EXISTS idx_audit_by       ON audit(by);

CREATE TABLE IF NOT EXISTS notifications (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT    NOT NULL,
    ts       REAL    NOT NULL,
    kind     TEXT    NOT NULL,   -- alert | resolved | event | digest | test
    alert_id TEXT,
    family   TEXT,
    level    TEXT,
    title    TEXT    NOT NULL,
    sent     INTEGER NOT NULL,   -- 1 envoyée, 0 supprimée
    reason   TEXT                -- motif de suppression, ou erreur d'envoi
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts DESC);
"""

# Conservation du journal des notifications. Ce ne sont que des traces
# d'exploitation : 30 jours suffisent à comprendre pourquoi un message est
# parti ou non, sans faire grossir la base indéfiniment.
NOTIFICATIONS_RETENTION_S = 30 * 86400


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class AuditLog:
    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        # check_same_thread=False : FastAPI sert depuis plusieurs threads.
        # Un verrou explicite sérialise les écritures.
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def record(
        self,
        by: str,
        category: str,
        target: str,
        detail: str,
        result: str = "succès",
        params: Optional[Dict[str, Any]] = None,
    ) -> None:
        if category not in CATEGORIES:
            log.warning("catégorie d'audit inconnue : %s", category)
            category = "system"
        if result not in RESULTS:
            result = "info"

        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO audit (at, by, category, target, detail, result, params)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        _now(),
                        by,
                        category,
                        target,
                        detail,
                        result,
                        json.dumps(params, ensure_ascii=False) if params else None,
                    ),
                )
                self._conn.commit()
        except Exception:
            # Un journal qui casse ne doit jamais empêcher l'action de réussir,
            # mais on veut le savoir dans les logs du conteneur.
            log.exception("échec d'écriture dans le journal d'audit")

    def query(
        self,
        limit: int = 100,
        offset: int = 0,
        category: Optional[str] = None,
        by: Optional[str] = None,
        result: Optional[str] = None,
    ) -> Dict[str, Any]:
        clauses: List[str] = []
        args: List[Any] = []
        if category and category in CATEGORIES:
            clauses.append("category = ?")
            args.append(category)
        if by:
            clauses.append("by = ?")
            args.append(by)
        if result and result in RESULTS:
            clauses.append("result = ?")
            args.append(result)

        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""

        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) AS n FROM audit{where}", args
            ).fetchone()["n"]
            rows = self._conn.execute(
                f"SELECT * FROM audit{where} ORDER BY id DESC LIMIT ? OFFSET ?",
                args + [max(1, min(limit, 5000)), max(0, offset)],
            ).fetchall()

        return {
            "total": total,
            # Acteurs réellement présents dans le journal, tous filtres confondus :
            # c'est ce qui peuple la liste déroulante de la vue Journal. Les
            # calculer ici évite d'écrire des comptes en dur dans l'interface, et
            # de proposer un filtre qui ne renverrait rien.
            "actors": self.actors(),
            "items": [
                {
                    "id": str(r["id"]),
                    "at": r["at"],
                    "by": r["by"],
                    "category": r["category"],
                    "target": r["target"],
                    "detail": r["detail"],
                    "result": r["result"],
                }
                for r in rows
            ],
        }

    def actors(self) -> List[str]:
        """Auteurs distincts d'une action, du plus actif au moins actif."""
        with self._lock:
            rows = self._conn.execute(
                # `by` est un mot-clé SQL : il doit être cité pour être lu comme
                # un nom de colonne dans une projection.
                'SELECT "by" AS actor, COUNT(*) AS n FROM audit '
                'GROUP BY "by" ORDER BY n DESC'
            ).fetchall()
        return [r["actor"] for r in rows if r["actor"]]

    # ------------------------------------------------- journal des notifications

    def record_notification(
        self,
        kind: str,
        title: str,
        sent: bool,
        *,
        alert_id: Optional[str] = None,
        family: Optional[str] = None,
        level: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        """Trace d'une notification, envoyée ou supprimée — et pourquoi.

        Sans ce journal, les règles de notification seraient invérifiables : on ne
        pourrait pas distinguer « rien ne s'est passé » de « le message a été
        retenu par les heures calmes ».
        """
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO notifications"
                    " (at, ts, kind, alert_id, family, level, title, sent, reason)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (_now(), time.time(), kind, alert_id, family, level, title,
                     1 if sent else 0, reason),
                )
                self._conn.execute(
                    "DELETE FROM notifications WHERE ts < ?",
                    (time.time() - NOTIFICATIONS_RETENTION_S,),
                )
                self._conn.commit()
        except Exception:
            log.exception("échec d'écriture dans le journal des notifications")

    def notifications(self, limit: int = 200, since_s: float = 7 * 86400) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM notifications WHERE ts >= ? ORDER BY id DESC LIMIT ?",
                (time.time() - since_s, max(1, min(limit, 2000))),
            ).fetchall()
        return [
            {
                "id": str(r["id"]),
                "at": r["at"],
                "kind": r["kind"],
                "alertId": r["alert_id"],
                "family": r["family"],
                "level": r["level"],
                "title": r["title"],
                "sent": bool(r["sent"]),
                "reason": r["reason"],
            }
            for r in rows
        ]

    def recent_system_actions(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Alimente `SystemData.recentActions` de la vue Système."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM audit WHERE category IN ('system', 'process')"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": str(r["id"]),
                "at": r["at"],
                "by": r["by"],
                "action": r["detail"],
                "target": r["target"],
                "result": r["result"],
            }
            for r in rows
        ]
