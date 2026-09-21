"""Routes de l'onglet Paramètres.

Séparées de `main.py` — qui déclare ses routes à plat, sans routeur — parce
qu'elles forment un ensemble cohérent d'une trentaine d'entrées et que les
regrouper dans un fichier de plus de mille lignes ne rendrait service à personne.
Les conventions restent celles du reste de l'API : `Depends(require_user)` sur
chaque route, corps en modèle Pydantic, erreurs en `HTTPException` avec un
message en français, audit de chaque mutation.

Le registre `settings.SETTINGS` est servi tel quel : l'interface se construit à
partir de lui, et il n'y a donc jamais deux descriptions d'un même réglage à
tenir à jour.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import confwrite, settings, telegram
from .auth import get_auth, require_user, verify_password

log = logging.getLogger("wopr.settings.api")

def restart_command(docker=None) -> str:
    """Commande à lancer pour que les réglages « à froid » prennent effet.

    Un `restart` ne suffirait pas : compose ne relit le `.env` qu'à la
    recréation. Le dossier est lu sur le conteneur du dashboard lui-même plutôt
    qu'écrit en dur — à défaut, on affiche la commande sans le `cd`.
    """
    directory = docker.self_stack_dir() if docker is not None else None
    if not directory:
        return "sudo docker compose up -d   # depuis le dossier de la stack"
    return f"cd {directory} && sudo docker compose up -d"

_MODE_LEVERS = {"cpuGovernor", "cpuEpp", "gpuPowerLimit", "fanCurvePreset",
                "ollamaKeepAlive", "containers"}
_GOVERNORS = {"performance", "powersave"}
_EPP = {"performance", "balance_performance", "balance_power", "power", "default"}


# --------------------------------------------------------------------- modèles


class SettingsPatch(BaseModel):
    values: Dict[str, Any] = Field(default_factory=dict)
    families: Optional[Dict[str, Dict[str, Any]]] = None


class SectionRequest(BaseModel):
    section: str


class PasswordRequest(BaseModel):
    current: str
    new: str


class TelegramTestRequest(BaseModel):
    botToken: str = ""
    chatId: str = ""


class YamlPayload(BaseModel):
    content: Dict[str, Any]


class ImportRequest(BaseModel):
    settings: Optional[Dict[str, Any]] = None
    thresholds: Optional[Dict[str, Any]] = None
    modes: Optional[Dict[str, Any]] = None


# ----------------------------------------------------------------- sérialisation


def _source_of(item: settings.Setting) -> str:
    """D'où vient la valeur effective : utile pour comprendre ce qu'on modifie."""
    if item.scope == "live" and settings.is_overridden(item.key):
        return "settings"
    if item.env and os.environ.get(item.env):
        return "env"
    return "default"


def _describe(item: settings.Setting) -> Dict[str, Any]:
    value = settings.saved_value(item)
    return {
        "key": item.key,
        "section": item.section,
        "label": item.label,
        "help": item.help,
        "kind": item.kind,
        "default": item.default,
        "env": item.env,
        "scope": item.scope,
        "unit": item.unit,
        "min": item.min,
        "max": item.max,
        # Résolus plutôt que lus tels quels : la liste des identités vient de
        # `config/owners.yaml` et n'existe pas dans le registre.
        "choices": settings.choices_of(item),
        "choiceLabels": settings.choice_labels_of(item),
        "secret": item.secret,
        "readonly": item.readonly,
        "advanced": item.advanced,
        # Un secret n'est jamais renvoyé en clair : l'interface affiche « défini »
        # et n'envoie une valeur que si l'on en saisit une nouvelle.
        "value": "" if item.secret else value,
        "isSet": bool(value) if item.secret else None,
        "source": _source_of(item),
    }


def _redact(key: str, value: Any) -> Any:
    item = settings.BY_KEY.get(key)
    return "***" if item is not None and item.secret else value


# ------------------------------------------------------------------- validation


def _check_thresholds(content: Dict[str, Any]) -> None:
    from .alerts import DEFAULTS
    for section, values in content.items():
        if section not in DEFAULTS:
            raise HTTPException(400, f"Section de seuils inconnue : « {section} ».")
        if not isinstance(values, dict):
            raise HTTPException(400, f"La section « {section} » doit être un ensemble de clés.")
        for key, value in values.items():
            if key == "parMontage":
                if not isinstance(value, dict):
                    raise HTTPException(400, "« parMontage » doit lister des points de montage.")
                for path, override in value.items():
                    if not str(path).startswith("/"):
                        raise HTTPException(400, f"« {path} » n'est pas un point de montage.")
                    if not isinstance(override, dict):
                        raise HTTPException(400, f"Surcharge illisible pour « {path} ».")
                    for oname, ovalue in override.items():
                        _check_number(f"{path}.{oname}", ovalue)
                continue
            if isinstance(value, bool):
                continue
            _check_number(f"{section}.{key}", value)


def _check_number(label: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(400, f"« {label} » attend un nombre.")
    if value < 0:
        raise HTTPException(400, f"« {label} » ne peut pas être négatif.")


def _check_modes(content: Dict[str, Any], engine, fan_presets: List[str]) -> None:
    modes = content.get("modes")
    if not isinstance(modes, list) or not modes:
        raise HTTPException(400, "Au moins un mode doit être défini.")

    seen = set()
    for mode in modes:
        if not isinstance(mode, dict):
            raise HTTPException(400, "Chaque mode doit être un ensemble de clés.")
        mid = str(mode.get("id", "")).strip()
        if not mid:
            raise HTTPException(400, "Un mode sans identifiant ne peut pas être enregistré.")
        if mid in seen:
            raise HTTPException(400, f"Deux modes portent l'identifiant « {mid} ».")
        seen.add(mid)
        if not str(mode.get("label", "")).strip():
            raise HTTPException(400, f"Le mode « {mid} » n'a pas de nom.")

        policies = mode.get("policies") or {}
        if not isinstance(policies, dict):
            raise HTTPException(400, f"Les leviers du mode « {mid} » sont illisibles.")
        for lever in policies:
            if lever not in _MODE_LEVERS:
                raise HTTPException(
                    400, f"Levier inconnu dans « {mid} » : « {lever} ». "
                         f"Leviers acceptés : {', '.join(sorted(_MODE_LEVERS))}.")
        gov = policies.get("cpuGovernor")
        if gov is not None and gov not in _GOVERNORS:
            raise HTTPException(400, f"Gouverneur inconnu dans « {mid} » : « {gov} ».")
        epp = policies.get("cpuEpp")
        if epp is not None and epp not in _EPP:
            raise HTTPException(400, f"Préférence de performance inconnue dans « {mid} » : « {epp} ».")
        preset = policies.get("fanCurvePreset")
        if preset is not None and preset not in fan_presets:
            raise HTTPException(
                400, f"Préréglage de ventilation inconnu dans « {mid} » : « {preset} ». "
                     f"Préréglages disponibles : {', '.join(fan_presets)}.")
        _check_power_limit(mid, policies.get("gpuPowerLimit"))
        containers = policies.get("containers") or {}
        if not isinstance(containers, dict):
            raise HTTPException(400, f"« containers » du mode « {mid} » est illisible.")
        for side in ("stop", "start"):
            names = containers.get(side, [])
            if not isinstance(names, list) or any(not isinstance(n, str) for n in names):
                raise HTTPException(
                    400, f"« containers.{side} » du mode « {mid} » doit être une liste de noms.")

    # On refuse de faire disparaître le mode actif ou le mode de repli : le
    # dashboard afficherait un mode qui n'existe plus, et le retour automatique
    # n'aurait plus de cible.
    from .modes import default_mode_id
    if engine.active_id not in seen:
        raise HTTPException(
            400, f"Le mode actif « {engine.active_id} » ne peut pas être supprimé. "
                 "Activez un autre mode d'abord.")
    fallback = default_mode_id()
    if fallback not in seen:
        raise HTTPException(
            400, f"Le mode de repli « {fallback} » doit exister. Changez-le dans la "
                 "section Modes avant de supprimer celui-ci.")


def _check_power_limit(mode_id: str, spec: Any) -> None:
    if spec is None:
        return
    if isinstance(spec, dict):
        for value in spec.values():
            _check_power_limit(mode_id, value)
        return
    if isinstance(spec, (int, float)) and not isinstance(spec, bool):
        if spec <= 0:
            raise HTTPException(400, f"Limite de puissance nulle ou négative dans « {mode_id} ».")
        return
    text = str(spec).strip()
    if text in ("max", "min"):
        return
    if text.endswith("%") and text[:-1].isdigit() and 0 < int(text[:-1]) <= 100:
        return
    raise HTTPException(
        400, f"Limite de puissance illisible dans « {mode_id} » : « {spec} ». "
             "Attendu : un nombre de watts, « max », « min » ou un pourcentage.")


def _apply_into(target: Any, patch: Any) -> Any:
    """Recopie `patch` dans `target` en conservant les commentaires de ruamel.

    Les clés absentes du patch sont retirées : l'éditeur envoie l'état complet
    d'une section, une suppression de surcharge doit donc se propager.
    """
    if not isinstance(target, dict) or not isinstance(patch, dict):
        return patch
    for key in [k for k in target if k not in patch]:
        del target[key]
    for key, value in patch.items():
        if key in target and isinstance(target[key], dict) and isinstance(value, dict):
            _apply_into(target[key], value)
        else:
            target[key] = value
    return target


# ---------------------------------------------------------------------- routeur


def build_router(*, audit, alerts, modes, cache, docker=None) -> APIRouter:
    router = APIRouter(prefix="/api/settings", tags=["paramètres"])

    def _state(user: str) -> Dict[str, Any]:
        return {
            "sections": settings.SECTIONS,
            "settings": [_describe(item) for item in settings.SETTINGS],
            "families": {
                "meta": [{"id": f["id"], "label": f["label"],
                          "patterns": f["patterns"]} for f in settings.FAMILIES],
                "levels": settings.FAMILY_LEVELS,
                "levelLabels": settings.FAMILY_LEVEL_LABELS,
                "rules": settings.families(),
            },
            "pendingRestart": settings.pending_restart(),
            "restartCommand": restart_command(docker),
            "writable": {
                "config": settings.config_writable(),
                "dotenv": settings.dotenv_writable(),
                "comments": confwrite.yaml_round_trip_available(),
            },
            "paths": {
                "settings": settings.SETTINGS_PATH,
                "thresholds": alerts.config_path,
                "modes": modes.config_path,
                "dotenv": settings.DOTENV_PATH,
            },
            "account": {"username": user, "users": sorted(get_auth().users)},
            "telegram": {"configured": telegram.configured()},
        }

    # ------------------------------------------------------------- lecture

    @router.get("")
    async def get_settings(user: str = Depends(require_user)):
        return _state(user)

    # ------------------------------------------------------------ écriture

    @router.post("")
    async def save_settings(req: SettingsPatch, user: str = Depends(require_user)):
        before = {key: settings.get(key) for key in req.values if key in settings.BY_KEY}
        try:
            changed = await asyncio.to_thread(settings.apply, req.values)
        except settings.ValidationError as exc:
            raise HTTPException(400, f"{settings.BY_KEY[exc.key].label} : {exc.message}"
                                if exc.key in settings.BY_KEY else exc.message)

        if req.families is not None:
            _save_families(req.families, user)

        touched = changed["live"] + changed["cold"]
        if touched:
            audit.record(
                user, "system", "paramètres",
                f"{len(touched)} réglage(s) modifié(s) : {', '.join(touched)}",
                "attention" if changed["cold"] else "succès",
                {key: [_redact(key, before.get(key)), _redact(key, settings.get(key))]
                 for key in touched},
            )
        return {"status": "ok", "changed": changed, **_state(user)}

    def _save_families(rules: Dict[str, Dict[str, Any]], user: str) -> None:
        known = {f["id"] for f in settings.FAMILIES}
        cleaned: Dict[str, Dict[str, Any]] = {}
        for family, rule in rules.items():
            if family not in known:
                raise HTTPException(400, f"Famille d'alerte inconnue : « {family} ».")
            level = str(rule.get("level", "inherit"))
            if level not in settings.FAMILY_LEVELS:
                raise HTTPException(400, f"Règle inconnue pour « {family} » : « {level} ».")
            cleaned[family] = {"level": level, "resolved": bool(rule.get("resolved", True))}
        previous = settings.families()
        settings.set_raw("notifications.families", cleaned)
        diff = {f: [previous.get(f, {}).get("level"), cleaned[f]["level"]]
                for f in cleaned if previous.get(f, {}).get("level") != cleaned[f]["level"]}
        if diff:
            audit.record(user, "system", "notifications",
                         f"règles de notification modifiées : {', '.join(diff)}",
                         "succès", diff)

    @router.post("/reset")
    async def reset_section(req: SectionRequest, user: str = Depends(require_user)):
        if req.section not in {s["id"] for s in settings.SECTIONS}:
            raise HTTPException(404, f"Section inconnue : « {req.section} ».")
        removed = await asyncio.to_thread(settings.reset_section, req.section)
        audit.record(user, "system", "paramètres",
                     f"section « {req.section} » réinitialisée "
                     f"({len(removed)} réglage(s))", "attention", {"removed": removed})
        return {"status": "ok", "removed": removed, **_state(user)}

    # ----------------------------------------------------------- mot de passe

    @router.post("/password")
    async def change_password(req: PasswordRequest, user: str = Depends(require_user)):
        auth = get_auth()
        digest = auth.users.get(user)
        if digest is None or not await asyncio.to_thread(verify_password, req.current, digest):
            audit.record(user, "system", "authentification",
                         "changement de mot de passe refusé : mot de passe actuel invalide",
                         "échec")
            raise HTTPException(403, "Mot de passe actuel incorrect.")
        if len(req.new) < 12:
            raise HTTPException(400, "Le nouveau mot de passe doit faire 12 caractères au moins.")
        if req.new == req.current:
            raise HTTPException(400, "Le nouveau mot de passe est identique à l'ancien.")
        if not settings.config_writable():
            raise HTTPException(
                503, "Le dossier de configuration est en lecture seule : le nouveau mot de "
                     "passe ne pourrait pas être enregistré.")

        await asyncio.to_thread(auth.set_password, user, req.new)
        audit.record(user, "system", "authentification", "mot de passe modifié", "attention")
        return {"status": "ok",
                "detail": "Mot de passe modifié. Les autres sessions ont été fermées."}

    # -------------------------------------------------------------- Telegram

    @router.post("/telegram/test")
    async def telegram_test(req: TelegramTestRequest, user: str = Depends(require_user)):
        ok, err = await asyncio.to_thread(telegram.test, req.botToken, req.chatId)
        audit.record(user, "system", "telegram",
                     "test de notification Telegram", "succès" if ok else "échec")
        if not ok:
            raise HTTPException(502, err or "Échec de l'envoi Telegram.")
        return {"status": "ok", "detail": "Message de test envoyé."}

    @router.get("/notifications/journal")
    async def notifications_journal(limit: int = 200, days: int = 7,
                                    user: str = Depends(require_user)):
        items = audit.notifications(limit=limit, since_s=max(1, min(days, 30)) * 86400)
        return {"items": items,
                "sent": sum(1 for i in items if i["sent"]),
                "suppressed": sum(1 for i in items if not i["sent"])}

    # ------------------------------------------------------------ seuils

    @router.get("/thresholds")
    async def get_thresholds(user: str = Depends(require_user)):
        return {"content": alerts.raw_config(), "path": alerts.config_path}

    @router.post("/thresholds")
    async def save_thresholds(req: YamlPayload, user: str = Depends(require_user)):
        _check_thresholds(req.content)
        _write_yaml(alerts.config_path, req.content)
        await asyncio.to_thread(alerts.reload)
        cache._values.pop("storage", None)
        audit.record(user, "system", "seuils d'alerte",
                     "seuils modifiés depuis l'onglet Paramètres", "succès")
        return {"status": "ok", "content": alerts.raw_config()}

    # -------------------------------------------------------------- modes

    @router.get("/modes")
    async def get_modes_config(user: str = Depends(require_user)):
        return {"content": modes.raw_config(), "path": modes.config_path,
                "activeId": modes.active_id,
                "fallbackId": _fallback_mode_id(),
                "fanPresets": sorted(modes.fans.presets)}

    @router.post("/modes")
    async def save_modes_config(req: YamlPayload, user: str = Depends(require_user)):
        _check_modes(req.content, modes, sorted(modes.fans.presets))
        _write_yaml(modes.config_path, req.content)
        await asyncio.to_thread(modes.reload)
        audit.record(user, "mode", "définitions",
                     f"{len(req.content.get('modes', []))} mode(s) enregistré(s) "
                     "depuis l'onglet Paramètres", "succès")
        return {"status": "ok", "content": modes.raw_config()}

    # --------------------------------------------------------- export / import

    @router.get("/export")
    async def export_config(secrets: bool = False, user: str = Depends(require_user)):
        blob = _copy_without_secrets(settings.load(), keep=secrets)
        audit.record(user, "system", "paramètres",
                     "configuration exportée" + (" (secrets compris)" if secrets else ""),
                     "info")
        return {
            "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "host": os.uname().nodename,
            "includesSecrets": secrets,
            "settings": blob,
            "thresholds": alerts.raw_config(),
            "modes": modes.raw_config(),
        }

    @router.post("/import")
    async def import_config(req: ImportRequest, user: str = Depends(require_user)):
        applied: List[str] = []
        if req.settings is not None:
            flat = _flatten(req.settings)
            values = {k: v for k, v in flat.items() if k in settings.BY_KEY}
            try:
                await asyncio.to_thread(settings.apply, values)
            except settings.ValidationError as exc:
                raise HTTPException(400, f"{exc.key} : {exc.message}")
            families = req.settings.get("notifications", {}).get("families")
            if isinstance(families, dict):
                _save_families(families, user)
            applied.append(f"{len(values)} réglage(s)")
        if req.thresholds is not None:
            _check_thresholds(req.thresholds)
            _write_yaml(alerts.config_path, req.thresholds)
            await asyncio.to_thread(alerts.reload)
            applied.append("seuils")
        if req.modes is not None:
            _check_modes(req.modes, modes, sorted(modes.fans.presets))
            _write_yaml(modes.config_path, req.modes)
            await asyncio.to_thread(modes.reload)
            applied.append("modes")
        if not applied:
            raise HTTPException(400, "Le fichier importé ne contient rien d'exploitable.")
        audit.record(user, "system", "paramètres",
                     "configuration importée : " + ", ".join(applied), "attention")
        return {"status": "ok", "applied": applied, **_state(user)}

    # ------------------------------------------------------- fichiers bruts

    @router.get("/files")
    async def raw_files(user: str = Depends(require_user)):
        out = []
        for label, path in (("settings.yaml", settings.SETTINGS_PATH),
                            ("thresholds.yaml", alerts.config_path),
                            ("modes.yaml", modes.config_path)):
            out.append({
                "label": label,
                "path": path,
                "exists": os.path.exists(path),
                # Le settings.yaml contient le jeton Telegram et l'empreinte du
                # mot de passe : on n'en renvoie jamais le contenu brut.
                "content": None if label == "settings.yaml" else _read(path),
                "backups": confwrite.list_backups(path),
            })
        return {"files": out}

    return router


# ------------------------------------------------------------------- utilitaires


def _write_yaml(path: str, content: Dict[str, Any]) -> None:
    if not os.access(os.path.dirname(path) or ".", os.W_OK):
        raise HTTPException(
            503, "Le dossier de configuration est monté en lecture seule. "
                 "Vérifiez la ligne « ./config:/config » du docker-compose.yml.")
    try:
        document = confwrite.load_yaml(path)
    except FileNotFoundError:
        document = {}
    except Exception:
        log.exception("%s illisible, il va être réécrit entièrement", path)
        document = {}
    _apply_into(document, content)
    confwrite.write_yaml(path, document)


def _fallback_mode_id() -> str:
    from .modes import default_mode_id
    return default_mode_id()


def _read(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _flatten(blob: Dict[str, Any], prefix: str = "") -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in blob.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict) and path not in settings.BY_KEY:
            out.update(_flatten(value, f"{path}."))
        else:
            out[path] = value
    return out


def _copy_without_secrets(blob: Dict[str, Any], *, keep: bool) -> Dict[str, Any]:
    flat = _flatten(blob)
    out: Dict[str, Any] = {}
    for key, value in flat.items():
        item = settings.BY_KEY.get(key)
        is_secret = (item is not None and item.secret) or key.startswith("security.users")
        if not keep and is_secret:
            continue
        parts = key.split(".")
        node = out
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return out
