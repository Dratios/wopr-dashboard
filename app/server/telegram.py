"""Notifications Telegram : quand le dashboard écrit, et surtout quand il se tait.

Brique volontairement passive : `alerts.py` détecte les transitions
(apparition/résolution) et appelle `notify_alert()`, qui ne fait qu'empiler
l'envoi dans une file traitée par un thread dédié — jamais d'appel réseau depuis
le thread qui évalue les alertes (partagé par `/api/alerts`, `/api/overview` et le
tick websocket toutes les 2 s).

Le filtrage tenait autrefois en une ligne : un niveau minimal global. Il obéit
maintenant à un jeu de règles réglable depuis l'onglet Paramètres, appliqué dans
cet ordre :

    interrupteur général → famille d'alerte → délai de confirmation →
    anti-répétition → heures calmes → débit maximal → groupement

Chaque décision, envoi comme suppression, est écrite dans le journal des
notifications (`data/audit.db`). C'est ce qui rend les règles vérifiables : sans
ce journal, on ne saurait pas distinguer « rien ne s'est passé » de « le message
a été retenu par les heures calmes ».

Si le jeton ou l'identifiant de conversation manque, la fonctionnalité est un
no-op silencieux : le dashboard doit fonctionner normalement sans Telegram.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

from . import settings
from .state_file import load_section, save_section

log = logging.getLogger("wopr.telegram")

_LEVEL_ORDER = {"err": 0, "warn": 1, "info": 2}
_LEVEL_LABEL = {"err": "🔴 Alerte critique", "warn": "🟠 Avertissement"}

_lock = threading.RLock()
_queue: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
_worker_thread: Optional[threading.Thread] = None
_ticker_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_state_path: Optional[str] = None
_audit: Any = None

# id -> {"lastSentAt": float, "notified": bool}
_notified: Dict[str, Dict[str, Any]] = {}
# Alertes en attente de confirmation : id -> {"deadline": float, "alert": {...}}
_confirming: Dict[str, Dict[str, Any]] = {}
# Messages en attente de regroupement, et messages retenus par les heures calmes.
_group: List[Dict[str, Any]] = []
_group_deadline: float = 0.0
_quiet_held: List[Dict[str, Any]] = []
# Horodatages des envois de l'heure écoulée, pour le débit maximal.
_sent_at: List[float] = []
_throttled_count: int = 0


# ------------------------------------------------------------------ paramètres


def _s(key: str) -> Any:
    return settings.get(f"notifications.{key}")


def configured() -> bool:
    return bool(_s("botToken") and _s("chatId"))


def enabled() -> bool:
    return bool(_s("enabled")) and configured()


# ---------------------------------------------------------------------- envoi


def send(text: str, *, token: str = "", chat_id: str = "") -> Tuple[bool, str]:
    """Envoi synchrone. Ne lève jamais. Renvoie (succès, message d'erreur).

    `token` et `chat_id` permettent de tester des identifiants avant de les
    enregistrer : c'est ce qu'utilise le bouton « envoyer un message de test ».
    """
    token = token or str(_s("botToken"))
    chat_id = chat_id or str(_s("chatId"))
    if not token or not chat_id:
        return False, "Jeton ou identifiant de conversation absent."
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text},
            timeout=10,
        )
        if resp.status_code != 200:
            detail = resp.text[:300]
            try:
                detail = resp.json().get("description", detail)
            except Exception:
                pass
            log.warning("échec d'envoi Telegram (%s) : %s", resp.status_code, detail)
            return False, f"Telegram a refusé l'envoi ({resp.status_code}) : {detail}"
        return True, ""
    except requests.Timeout:
        return False, "Telegram n'a pas répondu dans le délai imparti."
    except Exception as exc:
        log.exception("erreur réseau lors de l'envoi Telegram")
        return False, f"Erreur réseau : {exc}"


def _journal(kind: str, title: str, sent: bool, **kw: Any) -> None:
    if _audit is None:
        return
    try:
        _audit.record_notification(kind, title, sent, **kw)
    except Exception:
        log.exception("journal des notifications indisponible")


def _format(alert: Dict[str, Any], resolved: bool) -> str:
    component = alert.get("component", "?")
    message = alert.get("message", "")
    if resolved:
        return f"✅ Résolu — {component}\n{message}"
    label = _LEVEL_LABEL.get(alert.get("level"), "ℹ️ Information")
    return f"{label} — {component}\n{message}"


# ------------------------------------------------------------------- filtrage


def _family_rule(alert_id: str) -> Tuple[Optional[str], Dict[str, Any]]:
    fam = settings.family_of(alert_id)
    rules = settings.families()
    return fam, rules.get(fam or "", {"level": "inherit", "resolved": True})


def _passes_family(alert: Dict[str, Any]) -> Tuple[bool, str, Optional[str]]:
    """(autorisé, motif de refus, famille)"""
    aid = str(alert.get("id", ""))
    fam, rule = _family_rule(aid)
    level = rule.get("level", "inherit")
    if level == "never":
        return False, "famille réglée sur « jamais »", fam
    if level == "inherit":
        level = str(_s("minLevel"))
    threshold = _LEVEL_ORDER.get(level, 1)
    rank = _LEVEL_ORDER.get(str(alert.get("level")), 99)
    if rank > threshold:
        return False, f"niveau sous le seuil de la famille ({level})", fam
    return True, "", fam


def _in_quiet_hours(now: Optional[datetime] = None) -> bool:
    if not _s("quietHours.enabled"):
        return False
    now = now or datetime.now()
    try:
        sh, sm = (int(x) for x in str(_s("quietHours.start")).split(":"))
        eh, em = (int(x) for x in str(_s("quietHours.end")).split(":"))
    except (TypeError, ValueError):
        return False
    start, end, current = sh * 60 + sm, eh * 60 + em, now.hour * 60 + now.minute
    if start == end:
        return False
    # Une plage qui enjambe minuit (23:00 → 07:00) est la norme, pas l'exception.
    return start <= current < end if start < end else (current >= start or current < end)


def _rate_limited(now: float) -> bool:
    cap = int(_s("maxPerHour"))
    if cap <= 0:
        return False
    with _lock:
        _sent_at[:] = [t for t in _sent_at if now - t < 3600]
        return len(_sent_at) >= cap


# ----------------------------------------------------------------- expédition


def _emit(item: Dict[str, Any]) -> None:
    """Dernière étape avant l'envoi : débit maximal, puis groupement."""
    global _group_deadline, _throttled_count
    now = time.time()

    if _rate_limited(now):
        with _lock:
            _throttled_count += 1
        _journal(item["kind"], item["title"], False,
                 alert_id=item.get("alertId"), family=item.get("family"),
                 level=item.get("level"), reason="débit maximal atteint")
        return

    window = float(_s("groupWindowS"))
    if window <= 0:
        _dispatch([item])
        return

    with _lock:
        _group.append(item)
        if _group_deadline <= 0:
            _group_deadline = now + window


def _dispatch(items: List[Dict[str, Any]]) -> None:
    if not items:
        return
    if len(items) == 1:
        text = items[0]["text"]
    else:
        text = f"🗂 {len(items)} événements sur wopr\n\n" + "\n\n".join(i["text"] for i in items)

    ok, err = send(text)
    with _lock:
        if ok:
            _sent_at.append(time.time())
    for item in items:
        _journal(item["kind"], item["title"], ok,
                 alert_id=item.get("alertId"), family=item.get("family"),
                 level=item.get("level"), reason=None if ok else err)
    if ok:
        log.info("notification Telegram envoyée (%d élément(s))", len(items))


# ------------------------------------------------------------- entrées publiques


def notify_alert(alert: Dict[str, Any], resolved: bool) -> None:
    """Appelée par `alerts.py`. Jamais bloquante, jamais levée."""
    if not enabled():
        return
    try:
        _queue.put_nowait({"alert": alert, "resolved": resolved})
    except Exception:
        log.exception("mise en file de la notification impossible")


def notify_event(event: str, title: str, text: str) -> None:
    """Événement d'exploitation (changement de mode, reboot, action Docker…).

    Indépendant des alertes : sur une machine à deux administrateurs, savoir que
    l'autre vient de redémarrer le serveur vaut bien une notification.
    """
    if not enabled():
        return
    try:
        if not settings.get(f"notifications.events.{event}"):
            return
    except KeyError:
        log.warning("événement de notification inconnu : %s", event)
        return
    try:
        _queue.put_nowait({"event": event, "title": title, "text": text})
    except Exception:
        log.exception("mise en file de l'événement impossible")


def test(token: str = "", chat_id: str = "") -> Tuple[bool, str]:
    """Message de vérification, avec les identifiants fournis ou enregistrés."""
    host = time.strftime("%H:%M:%S")
    ok, err = send(f"🧪 Test du dashboard wopr — {host}\n"
                   "Si vous lisez ceci, les notifications sont opérationnelles.",
                   token=token, chat_id=chat_id)
    _journal("test", "Message de test", ok, reason=None if ok else err)
    return ok, err


# --------------------------------------------------------------------- traitement


def _handle_alert(alert: Dict[str, Any], resolved: bool) -> None:
    aid = str(alert.get("id", ""))
    now = time.time()
    allowed, refusal, fam = _passes_family(alert)
    title = f"{alert.get('component', '?')} — {alert.get('message', '')}"[:200]
    level = str(alert.get("level", ""))

    def drop(reason: str) -> None:
        _journal("resolved" if resolved else "alert", title, False,
                 alert_id=aid, family=fam, level=level, reason=reason)

    with _lock:
        entry = _notified.setdefault(aid, {"lastSentAt": 0.0, "notified": False})

        if resolved:
            _confirming.pop(aid, None)
            if not entry["notified"]:
                # L'apparition correspondante n'a jamais été notifiée : il n'y a
                # rien à « résoudre » du point de vue de la personne qui lit.
                return
            entry["notified"] = False
            _save()
            _, rule = _family_rule(aid)
            if not _s("notifyResolved") or not rule.get("resolved", True):
                drop("résolutions non notifiées pour cette famille")
                return
        else:
            if not allowed:
                drop(refusal)
                return
            if entry["notified"] and now - entry["lastSentAt"] < float(_s("cooldownS")):
                drop("anti-répétition")
                return

            delay = float(_s("confirmDelayS"))
            if delay > 0 and aid not in _confirming:
                # On retient l'alerte : si elle disparaît avant l'échéance, elle
                # n'aura jamais réveillé personne.
                _confirming[aid] = {"deadline": now + delay, "alert": dict(alert)}
                _journal("alert", title, False, alert_id=aid, family=fam, level=level,
                         reason=f"en attente de confirmation ({int(delay)} s)")
                return
            _confirming.pop(aid, None)
            entry["notified"] = True
            entry["lastSentAt"] = now
            _save()

    item = {
        "kind": "resolved" if resolved else "alert",
        "title": title, "text": _format(alert, resolved),
        "alertId": aid, "family": fam, "level": level,
    }
    _maybe_quiet(item, critical=(level == "err"))


def _maybe_quiet(item: Dict[str, Any], *, critical: bool) -> None:
    if _in_quiet_hours():
        if critical and _s("quietHours.allowCritical"):
            _emit(item)
            return
        if _s("quietHours.flush"):
            with _lock:
                _quiet_held.append(item)
            _journal(item["kind"], item["title"], False,
                     alert_id=item.get("alertId"), family=item.get("family"),
                     level=item.get("level"),
                     reason="heures calmes — sera envoyé à la fin de la plage")
        else:
            _journal(item["kind"], item["title"], False,
                     alert_id=item.get("alertId"), family=item.get("family"),
                     level=item.get("level"), reason="heures calmes")
        return
    _emit(item)


def _handle_event(event: str, title: str, text: str) -> None:
    _maybe_quiet({"kind": "event", "title": title, "text": text,
                  "alertId": None, "family": None, "level": "info"},
                 critical=False)


def _worker() -> None:
    log.info("thread de notification Telegram démarré")
    while True:
        item = _queue.get()
        if item is None:
            break
        try:
            if "alert" in item:
                _handle_alert(item["alert"], item["resolved"])
            else:
                _handle_event(item["event"], item["title"], item["text"])
        except Exception:
            log.exception("erreur lors du traitement d'une notification")
    log.info("thread de notification Telegram arrêté")


# ------------------------------------------------------------------- échéances

_was_quiet = False


def _ticker() -> None:
    """Seconde boucle : tout ce qui dépend du temps qui passe.

    Délais de confirmation arrivés à échéance, fenêtre de groupement close, sortie
    des heures calmes, relances périodiques et message de synthèse du débit
    maximal. Une seule horloge pour tout, réveillée chaque seconde.
    """
    global _group_deadline, _was_quiet, _throttled_count
    while not _stop.wait(1.0):
        try:
            now = time.time()

            # Délais de confirmation échus : l'alerte a tenu, on la notifie.
            with _lock:
                due = [aid for aid, c in _confirming.items() if c["deadline"] <= now]
                confirmed = [_confirming.pop(aid)["alert"] for aid in due]
            for alert in confirmed:
                aid = str(alert.get("id", ""))
                with _lock:
                    entry = _notified.setdefault(aid, {"lastSentAt": 0.0, "notified": False})
                    entry["notified"] = True
                    entry["lastSentAt"] = now
                    _save()
                level = str(alert.get("level", ""))
                fam = settings.family_of(aid)
                title = f"{alert.get('component', '?')} — {alert.get('message', '')}"[:200]
                _maybe_quiet({"kind": "alert", "title": title,
                              "text": _format(alert, False), "alertId": aid,
                              "family": fam, "level": level},
                             critical=(level == "err"))

            # Fenêtre de groupement close.
            with _lock:
                batch: List[Dict[str, Any]] = []
                if _group and 0 < _group_deadline <= now:
                    batch = list(_group)
                    _group.clear()
                    _group_deadline = 0.0
            if batch:
                _dispatch(batch)

            # Sortie des heures calmes : on envoie ce qui a été retenu.
            quiet = _in_quiet_hours()
            if _was_quiet and not quiet:
                with _lock:
                    held = list(_quiet_held)
                    _quiet_held.clear()
                if held:
                    log.info("fin des heures calmes : %d notification(s) retenue(s)", len(held))
                    _dispatch(held)
            _was_quiet = quiet

            # Message de synthèse quand le débit maximal a supprimé des envois.
            with _lock:
                skipped = _throttled_count
                if skipped and not _rate_limited(now):
                    _throttled_count = 0
                else:
                    skipped = 0
            if skipped:
                _dispatch([{"kind": "digest",
                            "title": f"{skipped} notification(s) supprimées",
                            "text": f"🔕 {skipped} notification(s) ont été supprimées par "
                                    f"le débit maximal pendant l'heure écoulée."}])

            # Relance des alertes toujours pas résolues.
            repeat_h = float(_s("repeatEveryH"))
            if repeat_h > 0:
                _repeat(now, repeat_h * 3600)
        except Exception:
            log.exception("erreur dans la boucle d'échéances des notifications")


def _repeat(now: float, period_s: float) -> None:
    with _lock:
        stale = [aid for aid, e in _notified.items()
                 if e.get("notified") and now - e.get("lastSentAt", 0) >= period_s]
    if not stale:
        return
    from . import alerts as _alerts_mod  # import tardif : évite une boucle d'import
    current = {a["id"]: a for a in _alerts_mod.last_known()}
    for aid in stale:
        alert = current.get(aid)
        if alert is None:
            continue
        with _lock:
            _notified[aid]["lastSentAt"] = now
            _save()
        _maybe_quiet({"kind": "alert",
                      "title": f"{alert.get('component', '?')} — toujours actif",
                      "text": "🔁 Toujours actif\n" + _format(alert, False),
                      "alertId": aid, "family": settings.family_of(aid),
                      "level": str(alert.get("level", ""))},
                     critical=(alert.get("level") == "err"))


def _save() -> None:
    if _state_path:
        save_section(_state_path, "telegram", _notified)


# ------------------------------------------------------------- cycle de vie


def start(state_path: str, audit_log: Any = None) -> None:
    global _worker_thread, _ticker_thread, _state_path, _audit, _was_quiet
    _state_path = state_path
    _audit = audit_log
    loaded = load_section(state_path, "telegram")
    if loaded:
        _notified.update(loaded)
    _was_quiet = _in_quiet_hours()

    if not configured():
        log.info("Telegram non configuré (jeton ou identifiant de conversation absent)")
    if _worker_thread is None:
        _worker_thread = threading.Thread(target=_worker, name="wopr-telegram", daemon=True)
        _worker_thread.start()
    if _ticker_thread is None:
        _ticker_thread = threading.Thread(target=_ticker, name="wopr-telegram-tick", daemon=True)
        _ticker_thread.start()
    notify_event("dashboardStart", "Dashboard démarré",
                 "🟢 Le dashboard wopr vient de démarrer.")


def stop() -> None:
    global _worker_thread, _ticker_thread
    _stop.set()
    if _worker_thread is not None:
        _queue.put_nowait(None)
        _worker_thread.join(timeout=5)
        _worker_thread = None
    if _ticker_thread is not None:
        _ticker_thread.join(timeout=3)
        _ticker_thread = None
