"""API du dashboard WOPR.

Toutes les routes `/api/*` exigent une session authentifiée, sauf `/api/status`
et la connexion elle-même. Chaque route mutante écrit une entrée d'audit nominative.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import psutil
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState
from pydantic import BaseModel, Field

from .alerts import AlertEngine
from .audit import AuditLog
from .auth import COOKIE_NAME, get_auth, owner_identity, require_user, require_user_ws
from .collector import SystemCollector
from .docker_manager import (
    SELF_CONTAINER_ID, SELF_FORBIDDEN_CONTAINER_ACTIONS,
    SELF_FORBIDDEN_STACK_ACTIONS, DockerManager, out_of_scope_stacks,
)
from .fans import FanController
from .gpu import gpu_manager
from . import owners
from .history_db import RANGES, HistoryUnavailable, history_db
from .hostexec import host
from .modes import ModeEngine
from . import settings
from . import speedtest
from . import telegram

logging.basicConfig(
    level=settings.get("general.logLevel"),
    format="%(asctime)s %(levelname)-7s %(name)-16s %(message)s",
)
log = logging.getLogger("wopr")


def _apply_log_level(_changed: List[str]) -> None:
    level = str(settings.get("general.logLevel"))
    logging.getLogger().setLevel(level)
    log.info("niveau de journal porté à %s", level)


settings.register_hook("general.logLevel", _apply_log_level)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_DIR = os.environ.get("WOPR_CONFIG_DIR", "/config")
DATA_DIR = os.environ.get("WOPR_DATA_DIR", "/data")
STATE_PATH = os.path.join(DATA_DIR, "state.json")

os.makedirs(DATA_DIR, exist_ok=True)

collector = SystemCollector()
docker_mgr = DockerManager()
audit = AuditLog(os.path.join(DATA_DIR, "audit.db"))
fans = FanController(STATE_PATH, audit=audit)
alerts = AlertEngine(os.path.join(CONFIG_DIR, "thresholds.yaml"), STATE_PATH)
modes = ModeEngine(
    os.path.join(CONFIG_DIR, "modes.yaml"), STATE_PATH,
    gpu_manager, fans, docker_mgr, audit=audit,
)


class Cache:
    """Cache très court sur les collectes coûteuses.

    La vue d'ensemble agrège sept sous-systèmes ; sans cela, une page ouverte sur
    trois onglets interrogerait le matériel vingt fois par seconde.
    """

    def __init__(self, ttl: float = 1.0) -> None:
        self.ttl = ttl
        self._values: Dict[str, tuple] = {}

    def get(self, key: str, producer):
        now = time.time()
        hit = self._values.get(key)
        if hit and now - hit[0] < self.ttl:
            return hit[1]
        value = producer()
        self._values[key] = (now, value)
        return value


cache = Cache(ttl=1.0)


def _storage_with_thresholds() -> Dict[str, Any]:
    data = collector.get_storage_network()
    for mount in data["mounts"]:
        mount.update(alerts.mount_thresholds(mount["path"]))
    return data


def snapshot() -> Dict[str, Any]:
    """Photographie complète, partagée par la vue d'ensemble et le WebSocket."""
    cpu_ram = cache.get("cpu_ram", collector.get_cpu_ram)
    thermal = cache.get("thermal", lambda: collector.get_thermal(fans))
    storage = cache.get("storage", _storage_with_thresholds)
    docker_data = cache.get("docker", docker_mgr.get_docker_data)
    gpu_data = cache.get("gpu", gpu_manager.get_gpu_data)
    system = cache.get("system", lambda: collector.get_system(audit))
    return {
        "cpuRam": cpu_ram, "thermal": thermal, "storageNetwork": storage,
        "docker": docker_data, "gpu": gpu_data, "system": system,
    }


def _sample_and_record() -> Dict[str, float]:
    """Un échantillon toutes les 5 s : en mémoire, et en file pour PostgreSQL."""
    sample = collector.sample_for_history()
    history_db.record(time.time(), sample)
    return sample


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("démarrage du dashboard WOPR")
    history_db.start()
    collector.history.start(_sample_and_record)
    fans.start()
    modes.start()
    telegram.start(STATE_PATH, audit)
    # Remet la machine dans l'état que l'interface annonce : sans cela, après un
    # redémarrage du conteneur, le mode affiché ne correspondrait plus aux
    # réglages réels du CPU et du GPU.
    try:
        modes.reapply()
    except Exception:
        log.exception("réapplication du mode actif impossible au démarrage")

    yield

    log.info("arrêt du dashboard WOPR")
    collector.history.stop()
    history_db.stop()
    modes.stop()
    telegram.stop()
    fans.shutdown()     # rend les ventilateurs à la carte mère
    docker_mgr.shutdown()


app = FastAPI(title="WOPR Dashboard", version="2.1.0", lifespan=lifespan)

# Les réglages ont leur propre module : une trentaine de routes de plus ici
# rendrait ce fichier illisible, et elles forment un ensemble cohérent.
from .settings_api import build_router  # noqa: E402  (après la création de `app`)

app.include_router(build_router(audit=audit, alerts=alerts, modes=modes,
                                cache=cache, docker=docker_mgr))


# --------------------------------------------------------------------- modèles


class LoginRequest(BaseModel):
    username: str
    password: str


class ActionRequest(BaseModel):
    action: str
    reason: str = ""


class ModeRequest(BaseModel):
    modeId: str
    reason: str = ""
    revertMinutes: int = 0


class ExtendRequest(BaseModel):
    minutes: int = Field(gt=0, le=720)


class FanRequest(BaseModel):
    mode: str                      # auto | manual | curve
    dutyPct: int = Field(default=50, ge=0, le=100)


class PresetRequest(BaseModel):
    preset: Optional[str] = None


class CurvePointRequest(BaseModel):
    index: int = Field(ge=0, le=15)
    temp: int = Field(ge=0, le=110)
    duty: int = Field(ge=0, le=100)


class PowerLimitRequest(BaseModel):
    watts: int = Field(ge=1, le=1000)


class ModelRequest(BaseModel):
    name: str
    pinned: bool = False


class KillRequest(BaseModel):
    signal: str = "SIGTERM"


class ReniceRequest(BaseModel):
    nice: int = Field(ge=-20, le=19)


class RebootRequest(BaseModel):
    reason: str
    confirm: str = ""


# ------------------------------------------------------------- authentification


@app.post("/api/auth/login")
async def login(req: LoginRequest, response: Response):
    auth = get_auth()
    try:
        accepted = auth.verify(req.username, req.password)
    except HTTPException as exc:
        if exc.status_code == 429:
            telegram.notify_event(
                "loginFailed", "Connexions refusées",
                f"🔐 Trop de tentatives de connexion pour « {req.username} » sur le "
                f"dashboard wopr. Le compte est temporairement bloqué.")
        raise
    if not accepted:
        audit.record(req.username, "system", "authentification",
                     "tentative de connexion refusée", "échec")
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    auth.issue(response, req.username)
    audit.record(req.username, "system", "authentification", "connexion réussie")
    return {"user": req.username}


@app.post("/api/auth/logout")
async def logout(response: Response, user: str = Depends(require_user)):
    get_auth().clear(response)
    return {"status": "ok"}


@app.get("/api/auth/me")
async def me(user: str = Depends(require_user)):
    return {"user": user}


@app.get("/api/status")
async def status(request: Request):
    """Sonde publique : dit si le backend est vivant et qui est connecté.

    Ne divulgue rien d'autre que l'état de la session en cours.
    """
    current = get_auth().read(request.cookies.get(COOKIE_NAME))
    return {
        "status": "online",
        "live": True,
        "hostname": os.uname().nodename,
        "authenticated": current is not None,
        "user": current,
        # Étiquette `com.wopr.owner` à laquelle correspond la personne connectée :
        # c'est elle qui détermine quels conteneurs sont « les siens ».
        "ownerIdentity": owner_identity(),
        # Identités déclarées dans `config/owners.yaml` : libellés, teintes et
        # infobulles. L'interface ne connaît aucun compte en dur, elle se dessine
        # à partir de cette liste.
        "owners": owners.payload(),
        "dockerAvailable": docker_mgr.is_available(),
        "gpuAvailable": gpu_manager.ready,
        "hostControl": host.available(),
        "historyDb": history_db.available,
    }


# ------------------------------------------------------------------- lectures


@app.get("/api/overview")
async def overview(user: str = Depends(require_user)):
    return await asyncio.to_thread(lambda: build_overview(snapshot()))


def evaluate_alerts(s: Dict[str, Any]) -> List[Dict[str, Any]]:
    return alerts.evaluate(s["cpuRam"], s["thermal"], s["storageNetwork"],
                           s["docker"], s["gpu"], s["system"])


def build_overview(s: Dict[str, Any], active: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Vue d'ensemble calculée à partir d'une photographie.

    Partagée par la route REST et le flux temps réel. Le flux n'envoyait autrefois
    que les alertes et le mode actif : tuiles, santé, uptime, charge et consommation
    restaient figés à leur valeur du chargement de la page.
    """
    cpu_ram, thermal = s["cpuRam"], s["thermal"]
    storage, docker_data = s["storageNetwork"], s["docker"]
    gpu_data, system = s["gpu"], s["system"]

    if active is None:
        active = evaluate_alerts(s)
    unacked = [a for a in active if not a["acknowledged"]]
    errors = [a for a in unacked if a["level"] == "err"]
    warnings = [a for a in unacked if a["level"] == "warn"]

    if errors:
        level, summary = "err", (
            f"{len(errors)} anomalie{'s' if len(errors) > 1 else ''} à traiter")
        detail = errors[0]["message"]
    elif warnings:
        level, summary = "warn", (
            f"{len(warnings)} point{'s' if len(warnings) > 1 else ''} de vigilance")
        detail = warnings[0]["message"]
    else:
        level, summary = "ok", "Système nominal"
        detail = "Aucun seuil dépassé sur les sous-systèmes surveillés."

    hist = collector.history.snapshot()
    cpu, ram = cpu_ram["cpu"], cpu_ram["ram"]
    agg = gpu_data["aggregate"]

    temps = [x["tempC"] for x in thermal["sensors"]]
    hottest = max(thermal["sensors"], key=lambda x: x["tempC"]) if thermal["sensors"] else None

    root = next((m for m in storage["mounts"] if m["path"] == "/"), None)
    primary_nic = next((i for i in storage["interfaces"]
                        if not i["virtual"] and i["up"]), None)
    services = system.get("services", [])
    services_up = sum(1 for s_ in services if s_["state"] == "active")

    def spark(key: str) -> List[float]:
        return [round(v, 1) for v in hist.get(key, [])[-20:]]

    cpu_power = cpu.get("powerW")
    gpu_power = agg.get("powerW")
    power_estimate = None
    if cpu_power is not None or gpu_power is not None:
        # Le reste de la machine (carte mère, disques, ventilateurs) n'est pas
        # mesurable ici : on somme ce qui l'est et l'UI précise la portée.
        power_estimate = round((cpu_power or 0) + (gpu_power or 0))

    subsystems = [
        {
            "id": "cpu", "label": "Processeur", "viewId": "cpu-ram",
            "value": f"{cpu['utilPct']} %",
            "subvalue": " · ".join(filter(None, [
                f"{cpu['tempPkgC']} °C" if cpu["tempPkgC"] is not None else None,
                f"{cpu['freqMhzAvg']} MHz" if cpu["freqMhzAvg"] else None,
                cpu["governor"] or None,
            ])),
            "level": "err" if cpu["utilPct"] > 95 else "warn" if cpu["utilPct"] > 85 else "ok",
            "spark": spark("cpu"),
        },
        {
            "id": "ram", "label": "Mémoire vive", "viewId": "cpu-ram",
            "value": f"{ram['usedGiB']} Gio",
            "subvalue": f"sur {ram['totalGiB']} Gio · {ram['cacheGiB']} Gio de cache",
            "level": ("err" if ram["usedGiB"] > ram["totalGiB"] * 0.95
                      else "warn" if ram["usedGiB"] > ram["totalGiB"] * 0.85 else "ok"),
            "spark": spark("ramPct"),
        },
        {
            "id": "gpu", "label": "Calcul GPU", "viewId": "gpu",
            "value": (f"{agg['utilAvgPct']} %" if gpu_data["available"] else "indisponible"),
            "subvalue": (
                f"{agg['vramUsedMiB'] / 1024:.1f} / {agg['vramTotalMiB'] / 1024:.1f} Gio VRAM"
                f" · {agg['count']} carte{'s' if agg['count'] > 1 else ''}"
                if gpu_data["available"] and agg["vramTotalMiB"]
                else (gpu_data.get("unavailableReason") or "aucune carte détectée")
            ),
            "level": ("inactive" if not gpu_data["available"]
                      else "err" if agg["pressure"] == "saturé"
                      else "warn" if agg["pressure"] == "tendu" else "ok"),
            "spark": spark("gpu"),
        },
        {
            "id": "thermal", "label": "Thermique & ventilation", "viewId": "thermal",
            "value": f"{max(temps)} °C" if temps else "—",
            "subvalue": (
                f"{hottest['label']} · {len(thermal['fans'])} ventilateur"
                f"{'s' if len(thermal['fans']) > 1 else ''}"
                if hottest else "aucun capteur"
            ),
            "level": ("err" if any(s_["tempC"] >= s_["critC"] for s_ in thermal["sensors"])
                      else "warn" if any(s_["tempC"] >= s_["warnC"] for s_ in thermal["sensors"])
                      else "ok"),
            "spark": spark("tempMax"),
        },
        {
            "id": "docker", "label": "Conteneurs Docker", "viewId": "docker",
            "value": (f"{docker_data['summary']['running']} / {docker_data['summary']['total']} actifs"
                      if docker_data["available"] else "indisponible"),
            "subvalue": (
                f"{docker_data['summary']['unhealthy']} en anomalie"
                if docker_data["available"]
                else (docker_data.get("unavailableReason") or "")
            ),
            "level": ("inactive" if not docker_data["available"]
                      else "err" if docker_data["summary"]["unhealthy"] else "ok"),
        },
        {
            "id": "storage", "label": "Stockage", "viewId": "storage-network",
            "value": f"{root['usedPct']} %" if root else "—",
            "subvalue": (f"{root['usedGiB']:.0f} / {root['totalGiB']:.0f} Gio sur /"
                         if root else "montage racine introuvable"),
            "level": ("err" if any(m["usedPct"] >= m["critPct"] or not m["reachable"]
                                   for m in storage["mounts"])
                      else "warn" if any(m["usedPct"] >= m["warnPct"] for m in storage["mounts"])
                      else "ok"),
        },
        {
            "id": "network", "label": "Réseau", "viewId": "storage-network",
            "value": (f"↓ {primary_nic['rxMBs']} Mo/s" if primary_nic else "—"),
            "subvalue": (
                f"↑ {primary_nic['txMBs']} Mo/s · {primary_nic['name']} "
                f"{primary_nic['speedMbps']} Mb/s"
                if primary_nic else "aucune interface active"
            ),
            "level": "ok" if primary_nic else "err",
            "spark": spark("netRx"),
        },
        {
            "id": "services", "label": "Services critiques", "viewId": "system",
            "value": (f"{services_up} / {len(services)} actifs" if services else "—"),
            "subvalue": (", ".join(s_["description"] for s_ in services[:3])
                         if services else "état non lisible depuis le conteneur"),
            "level": ("inactive" if not services
                      else "err" if any(s_["state"] == "failed" for s_ in services)
                      else "ok" if services_up == len(services) else "warn"),
        },
    ]

    return {
        "host": system.get("hostname") or os.uname().nodename,
        "health": {"level": level, "summary": summary, "detail": detail},
        "uptimeSeconds": int(time.time() - collector.boot_time),
        "loadavg": cpu["loadavg"],
        "activeMode": modes.active_summary(),
        "powerEstimateW": power_estimate,
        "powerScope": "CPU (RAPL) + GPU (NVML)" if power_estimate is not None else None,
        "subsystems": subsystems,
        "alerts": active,
        "historicalMetrics": {
            "timestamps": [time.strftime("%H:%M:%S", time.localtime(t)) for t in hist["t"]],
            "cpuPct": [round(v, 1) for v in hist["cpu"]],
            "ramPct": [round(v, 1) for v in hist["ramPct"]],
            "gpuPct": [round(v, 1) for v in hist["gpu"]],
            "tempMaxC": [round(v, 1) for v in hist["tempMax"]],
            "netRxMBs": [round(v, 2) for v in hist["netRx"]],
            "netTxMBs": [round(v, 2) for v in hist["netTx"]],
        },
    }


# Les collectes appellent le matériel, le démon Docker ou des commandes hôte : elles
# tournent hors de la boucle d'événements pour ne pas bloquer les autres requêtes.

@app.get("/api/cpu-ram")
async def get_cpu_ram(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "cpu_ram", collector.get_cpu_ram)


@app.get("/api/gpu")
async def get_gpu(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "gpu", gpu_manager.get_gpu_data)


@app.get("/api/thermal")
async def get_thermal(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "thermal", lambda: collector.get_thermal(fans))


@app.get("/api/storage-network")
async def get_storage_network(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "storage", _storage_with_thresholds)


@app.get("/api/docker")
async def get_docker(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "docker", docker_mgr.get_docker_data)


@app.get("/api/processes")
async def get_processes(user: str = Depends(require_user)):
    return await asyncio.to_thread(collector.get_processes)


@app.get("/api/system")
async def get_system(user: str = Depends(require_user)):
    return await asyncio.to_thread(cache.get, "system", lambda: collector.get_system(audit))


@app.get("/api/modes")
async def get_modes(user: str = Depends(require_user)):
    return modes.get_modes_data()


@app.get("/api/alerts")
async def get_alerts(user: str = Depends(require_user)):
    return await asyncio.to_thread(lambda: evaluate_alerts(snapshot()))


# Noms de métriques de l'historique : `cpu`, `netRx`, `temp:k10temp-0`, `fan:avg`…
_METRIC_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_.-")


@app.get("/api/history")
async def get_history(range: str = "1h", metrics: str = "", user: str = Depends(require_user)):
    keys = [m for m in metrics.split(",") if m]
    if range not in RANGES:
        raise HTTPException(400, f"Fenêtre « {range} » inconnue ({', '.join(RANGES)})")
    if not keys or len(keys) > 24 or any(len(k) > 64 or not set(k) <= _METRIC_CHARS for k in keys):
        raise HTTPException(400, "Liste de métriques invalide")
    try:
        return await asyncio.to_thread(history_db.query, range, keys)
    except HistoryUnavailable as exc:
        raise HTTPException(503, str(exc))


@app.get("/api/audit")
async def get_audit(limit: int = 100, offset: int = 0, category: Optional[str] = None,
                    by: Optional[str] = None, result: Optional[str] = None,
                    user: str = Depends(require_user)):
    return audit.query(limit=limit, offset=offset, category=category, by=by, result=result)


# -------------------------------------------------------------------- Docker


def _find_container(container_id: str) -> Optional[Dict[str, Any]]:
    data = docker_mgr.get_docker_data()
    for stack in data.get("stacks", []):
        for c in stack["containers"]:
            if container_id in (c["id"], c["fullId"], c["name"]):
                return {"container": c, "stack": stack}
    return None


def _schedule_self_restart(user: str, target: str, restart, params: Dict[str, Any]) -> None:
    """Redémarre le dashboard lui-même, après avoir répondu.

    Pendant un redémarrage, Docker envoie SIGTERM à ce processus. Attendre la fin
    de l'appel dans la requête, c'est ne jamais répondre ni écrire l'audit — et,
    la boucle étant occupée, ne pas s'arrêter proprement : SIGKILL au bout du délai,
    sans passer par le `lifespan` qui rend les ventilateurs à la carte mère.

    On consigne donc la demande d'abord, on répond, puis un thread détaché passe
    l'ordre au démon. Celui-ci mène le redémarrage à son terme même si le
    processus qui l'a demandé disparaît en route (vérifié le 2026-09-15).
    """
    audit.record(user, "docker", target,
                 "redémarrage du dashboard lui-même demandé", "info", params)

    def run() -> None:
        time.sleep(1.0)  # laisse partir la réponse HTTP
        log.info("redémarrage du dashboard demandé par %s", user)
        if not restart():
            audit.record(user, "docker", target,
                         "le redémarrage du dashboard a échoué", "échec", params)

    threading.Thread(target=run, name="self-restart", daemon=True).start()


@app.post("/api/docker/container/{container_id}/action")
async def container_action(container_id: str, req: ActionRequest,
                           user: str = Depends(require_user)):
    found = await asyncio.to_thread(_find_container, container_id)
    if not found:
        raise HTTPException(404, f"Conteneur « {container_id} » introuvable")

    container, stack = found["container"], found["stack"]
    if stack["outOfScope"]:
        audit.record(user, "docker", container["name"],
                     f"action {req.action} refusée : stack hors périmètre", "échec")
        raise HTTPException(
            403, f"La stack « {stack['name']} » est hors du périmètre du dashboard.")

    if container["isSelf"]:
        params = {"stack": stack["name"], "owner": container["owner"], "reason": req.reason}
        if req.action in SELF_FORBIDDEN_CONTAINER_ACTIONS:
            audit.record(user, "docker", container["name"],
                         f"action {req.action} refusée : conteneur du dashboard", "échec", params)
            raise HTTPException(
                403, f"Le dashboard ne peut pas faire « {req.action} » sur son propre "
                     "conteneur : il ne pourrait plus être relancé depuis l'interface. "
                     "Passez par `docker compose` sur wopr.")
        if req.action == "restart":
            _schedule_self_restart(
                user, container["name"],
                lambda: docker_mgr.container_action(SELF_CONTAINER_ID, "restart"), params)
            return {"status": "ok", "action": req.action, "containerId": container["id"],
                    "detail": "Le dashboard redémarre — reconnexion dans quelques secondes"}

    ok = await asyncio.to_thread(docker_mgr.container_action, container["fullId"], req.action)
    cache._values.pop("docker", None)

    owner_note = ("" if container["owner"] in (owner_identity(), "shared")
                  else f" — conteneur appartenant à {container['owner']}")
    if owner_note and ok:
        telegram.notify_event(
            "otherOwnerDocker", f"{req.action} sur {container['name']}",
            f"📦 {user} a fait « {req.action} » sur le conteneur "
            f"« {container['name']} » de la stack « {stack['name']} », "
            f"qui appartient à {container['owner']}.")
    audit.record(
        user, "docker", container["name"],
        f"{req.action} sur le conteneur{owner_note}",
        "succès" if ok else "échec",
        {"stack": stack["name"], "owner": container["owner"], "reason": req.reason},
    )
    if not ok:
        raise HTTPException(400, f"Échec de l'action « {req.action} »")
    return {"status": "ok", "action": req.action, "containerId": container["id"]}


@app.post("/api/docker/stack/{stack_name}/action")
async def stack_action(stack_name: str, req: ActionRequest,
                       user: str = Depends(require_user)):
    if stack_name in out_of_scope_stacks():
        audit.record(user, "docker", stack_name,
                     f"action {req.action} refusée : stack hors périmètre", "échec")
        raise HTTPException(403, f"La stack « {stack_name} » est hors du périmètre.")

    data = await asyncio.to_thread(docker_mgr.get_docker_data)
    if any(s["name"] == stack_name and s["containsSelf"] for s in data.get("stacks", [])):
        params = {"reason": req.reason}
        if req.action in SELF_FORBIDDEN_STACK_ACTIONS:
            audit.record(user, "docker", stack_name,
                         f"action {req.action} refusée : stack du dashboard", "échec", params)
            raise HTTPException(
                403, f"« {req.action} » sur la stack du dashboard doit se faire depuis un "
                     "shell sur wopr : le dashboard serait arrêté en cours d'opération.")
        if req.action == "restart":
            _schedule_self_restart(
                user, stack_name,
                lambda: docker_mgr.stack_action(stack_name, "restart")[0], params)
            return {"status": "ok", "action": req.action, "stack": stack_name,
                    "detail": "Le dashboard redémarre — reconnexion dans quelques secondes"}

    ok, detail = await asyncio.to_thread(docker_mgr.stack_action, stack_name, req.action)
    cache._values.pop("docker", None)

    audit.record(user, "docker", stack_name,
                 f"{req.action} sur la stack : {detail}",
                 "succès" if ok else "échec", {"reason": req.reason})
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "action": req.action, "stack": stack_name, "detail": detail}


@app.get("/api/docker/container/{container_id}/logs")
async def container_logs(container_id: str, tail: int = 200,
                         user: str = Depends(require_user)):
    found = await asyncio.to_thread(_find_container, container_id)
    if not found:
        raise HTTPException(404, f"Conteneur « {container_id} » introuvable")
    logs = await asyncio.to_thread(
        docker_mgr.get_logs, found["container"]["fullId"], min(tail, 2000))
    return {"containerId": found["container"]["id"], "logs": logs}


# ----------------------------------------------------------------------- GPU


@app.post("/api/gpu/{index}/power-limit")
async def set_power_limit(index: int, req: PowerLimitRequest,
                          user: str = Depends(require_user)):
    ok, detail = await asyncio.to_thread(gpu_manager.set_power_limit, index, req.watts)
    cache._values.pop("gpu", None)
    audit.record(user, "system", f"GPU {index}",
                 f"limite de puissance → {req.watts} W ({detail})",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "watts": req.watts}


@app.post("/api/models/load")
async def load_model(req: ModelRequest, user: str = Depends(require_user)):
    ok, detail = await asyncio.to_thread(gpu_manager.load_model, req.name)
    cache._values.pop("gpu", None)
    audit.record(user, "llm", req.name, f"chargement du modèle en VRAM ({detail})",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "model": req.name}


@app.post("/api/models/unload")
async def unload_model(req: ModelRequest, user: str = Depends(require_user)):
    ok, detail = await asyncio.to_thread(gpu_manager.unload_model, req.name)
    cache._values.pop("gpu", None)
    audit.record(user, "llm", req.name, f"déchargement du modèle ({detail})",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "model": req.name}


@app.post("/api/models/pin")
async def pin_model(req: ModelRequest, user: str = Depends(require_user)):
    ok, detail = await asyncio.to_thread(gpu_manager.pin_model, req.name, req.pinned)
    cache._values.pop("gpu", None)
    audit.record(user, "llm", req.name,
                 "modèle épinglé en VRAM" if req.pinned else "modèle désépinglé",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "model": req.name, "pinned": req.pinned}


# ---------------------------------------------------------------- ventilation


@app.post("/api/thermal/fan/{fan_id}")
async def control_fan(fan_id: str, req: FanRequest, user: str = Depends(require_user)):
    if req.mode == "manual":
        ok, detail = fans.set_manual(fan_id, req.dutyPct, user=user)
    elif req.mode == "auto":
        ok, detail = fans.set_auto(fan_id, user=user)
    elif req.mode == "curve":
        ok, detail = fans.set_curve_mode(fan_id, user=user)
    else:
        raise HTTPException(400, f"mode « {req.mode} » inconnu")

    cache._values.pop("thermal", None)
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "fanId": fan_id, "mode": req.mode, "detail": detail}


@app.post("/api/thermal/preset")
async def set_preset(req: PresetRequest, user: str = Depends(require_user)):
    ok, detail = fans.set_preset(req.preset, user=user)
    cache._values.pop("thermal", None)
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "preset": req.preset, "detail": detail}


@app.post("/api/thermal/curve-point")
async def update_curve_point(req: CurvePointRequest, user: str = Depends(require_user)):
    ok, detail = fans.update_curve_point(req.index, req.temp, req.duty, user=user)
    cache._values.pop("thermal", None)
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "detail": detail}


# --------------------------------------------------------------------- modes


@app.post("/api/modes/activate")
async def activate_mode(req: ModeRequest, user: str = Depends(require_user)):
    try:
        result = await asyncio.to_thread(
            modes.set_mode, req.modeId, user, req.reason, req.revertMinutes)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    for key in ("cpu_ram", "gpu", "thermal"):
        cache._values.pop(key, None)
    label = modes.modes.get(req.modeId, {}).get("label", req.modeId)
    telegram.notify_event(
        "modeChange", f"Mode « {label} »",
        f"🎚 {user} a activé le mode « {label} » sur wopr."
        + (f"\nMotif : {req.reason}" if req.reason.strip() else ""))
    return result


@app.post("/api/modes/extend")
async def extend_mode(req: ExtendRequest, user: str = Depends(require_user)):
    return {"status": "ok", "autoRevertAt": modes.extend(req.minutes, user)}


@app.post("/api/modes/revert")
async def revert_mode(user: str = Depends(require_user)):
    result = await asyncio.to_thread(modes.revert, user)
    for key in ("cpu_ram", "gpu", "thermal"):
        cache._values.pop(key, None)
    return result


# ----------------------------------------------------------------- processus


@app.post("/api/processes/{pid}/kill")
async def kill_process(pid: int, req: KillRequest, user: str = Depends(require_user)):
    sig = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL}.get(req.signal.upper())
    if sig is None:
        raise HTTPException(400, "signal accepté : SIGTERM ou SIGKILL")
    if pid == 1:
        raise HTTPException(403, "PID 1 (init) ne peut pas être arrêté depuis l'interface")
    if pid == os.getpid():
        raise HTTPException(
            403, "Ce PID est le dashboard lui-même : utilisez « Redémarrer » dans la vue Docker.")

    try:
        proc = psutil.Process(pid)
        name = proc.name()
        proc.send_signal(sig)
    except psutil.NoSuchProcess:
        raise HTTPException(404, f"PID {pid} inexistant")
    except psutil.AccessDenied:
        audit.record(user, "process", str(pid), f"{req.signal} refusé (permissions)", "échec")
        raise HTTPException(403, "Permissions insuffisantes pour signaler ce processus")
    except Exception as exc:
        raise HTTPException(400, str(exc))

    audit.record(user, "process", f"{name} (PID {pid})", f"{req.signal} envoyé")
    return {"status": "ok", "pid": pid, "signal": req.signal}


@app.post("/api/processes/{pid}/renice")
async def renice_process(pid: int, req: ReniceRequest, user: str = Depends(require_user)):
    try:
        proc = psutil.Process(pid)
        name = proc.name()
        proc.nice(req.nice)
    except psutil.NoSuchProcess:
        raise HTTPException(404, f"PID {pid} inexistant")
    except psutil.AccessDenied:
        audit.record(user, "process", str(pid), "renice refusé (permissions)", "échec")
        raise HTTPException(403, "Permissions insuffisantes")
    except Exception as exc:
        raise HTTPException(400, str(exc))

    audit.record(user, "process", f"{name} (PID {pid})", f"priorité réglée à {req.nice}")
    return {"status": "ok", "pid": pid, "nice": req.nice}


# ------------------------------------------------------------------- système


@app.post("/api/system/service/{service}/restart")
async def restart_service(service: str, user: str = Depends(require_user)):
    allowed = {s[0] for s in SystemCollector.WATCHED_SERVICES if s[2]}
    if service not in allowed:
        raise HTTPException(
            403, f"« {service} » ne fait pas partie des services redémarrables.")

    res = await asyncio.to_thread(host.run, "systemctl", ["restart", service], timeout=60)
    cache._values.pop("system", None)
    audit.record(user, "system", service, "redémarrage du service",
                 "succès" if res.ok else "échec",
                 {"stderr": res.stderr[:500]} if not res.ok else None)
    if not res.ok:
        raise HTTPException(400, res.stderr.strip() or "échec du redémarrage")
    return {"status": "ok", "service": service}


@app.post("/api/system/drop-caches")
async def drop_caches(user: str = Depends(require_user)):
    await asyncio.to_thread(host.run, "sync", [], timeout=30)
    try:
        with open("/proc/sys/vm/drop_caches", "w") as f:
            f.write("3")
        ok, detail = True, "cache de pages, dentries et inodes libérés"
    except Exception as exc:
        ok, detail = False, str(exc)

    cache._values.pop("cpu_ram", None)
    audit.record(user, "system", "mémoire", f"vidage des caches : {detail}",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(400, detail)
    return {"status": "ok", "detail": detail}


@app.post("/api/network/speedtest")
async def run_speedtest(user: str = Depends(require_user)):
    try:
        result = await asyncio.to_thread(speedtest.run)
    except speedtest.SpeedtestBusy:
        raise HTTPException(409, "Un test de débit est déjà en cours")
    except speedtest.SpeedtestTooSoon as exc:
        raise HTTPException(
            429, f"Merci de patienter encore {exc.retry_after:.0f} s avant un nouveau test")

    detail = (f"{result['downloadMbps']} Mb/s ↓ / {result['uploadMbps']} Mb/s ↑ "
              f"/ {result['latencyMs']} ms")
    audit.record(user, "system", "réseau", f"test de débit : {detail}", "info")
    return result


@app.post("/api/system/reboot")
async def reboot(req: RebootRequest, user: str = Depends(require_user)):
    # Le redémarrage coupe aussi les services de l'autre administrateur, et les
    # bases de données. On exige une confirmation explicite en toutes lettres,
    # côté serveur — une boîte de dialogue côté client ne protège de rien.
    if req.confirm.strip().lower() != "redemarrer":
        raise HTTPException(
            400, "Confirmation requise : envoyez confirm = « redemarrer ».")
    if not req.reason.strip():
        raise HTTPException(400, "Un motif est requis pour redémarrer la machine.")

    if not await asyncio.to_thread(host.available):
        audit.record(user, "system", "machine", "redémarrage impossible : pas d'accès hôte", "échec")
        raise HTTPException(503, "Le conteneur n'a pas accès à l'hôte.")

    audit.record(user, "system", "machine",
                 f"redémarrage de la machine demandé : {req.reason}",
                 "attention", {"reason": req.reason})

    telegram.notify_event(
        "reboot", "Redémarrage de wopr",
        f"♻️ {user} redémarre la machine wopr.\nMotif : {req.reason}")

    fans.shutdown()  # rendre les ventilateurs au BIOS avant de couper
    res = await asyncio.to_thread(host.run, "systemctl", ["reboot"], timeout=15)
    if not res.ok:
        await asyncio.to_thread(fans.resume)
        audit.record(user, "system", "machine",
                     f"le redémarrage a échoué : {res.stderr[:200]}", "échec")
        raise HTTPException(400, res.stderr.strip() or "échec du redémarrage")
    return {"status": "ok", "detail": "Redémarrage de wopr en cours"}


@app.post("/api/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str, user: str = Depends(require_user)):
    if not alerts.acknowledge(alert_id):
        raise HTTPException(404, "Alerte inconnue ou déjà résolue")
    audit.record(user, "alert", alert_id, "alerte acquittée", "info")
    return {"status": "ok", "id": alert_id}


@app.post("/api/notifications/test")
async def test_notification(user: str = Depends(require_user)):
    if not telegram.configured():
        raise HTTPException(
            400, "Telegram non configuré : renseignez le jeton du bot et "
                 "l'identifiant de conversation dans l'onglet Paramètres.")
    ok, err = await asyncio.to_thread(telegram.test)
    audit.record(user, "system", "telegram", "test de notification Telegram",
                 "succès" if ok else "échec")
    if not ok:
        raise HTTPException(502, err or "Échec de l'envoi Telegram.")
    return {"status": "ok", "detail": "Message de test envoyé"}


# ----------------------------------------------------------------- WebSocket


@app.websocket("/ws/telemetry")
async def telemetry(websocket: WebSocket):
    user = await require_user_ws(websocket)
    if user is None:
        await websocket.close(code=4401, reason="authentification requise")
        return

    await websocket.accept()
    log.info("flux de télémétrie ouvert pour %s", user)
    try:
        while True:
            payload = await asyncio.to_thread(_telemetry_payload, user)
            # le client a pu se déconnecter pendant la collecte (qui passe par
            # un thread) ; envoyer quand même déclenche une RuntimeError côté
            # Starlette ("... after sending 'websocket.close'")
            if websocket.application_state != WebSocketState.CONNECTED:
                break
            try:
                await websocket.send_json(payload)
            except (WebSocketDisconnect, RuntimeError):
                break
            await asyncio.sleep(2.0)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("erreur dans le flux de télémétrie")
    finally:
        log.info("flux de télémétrie fermé pour %s", user)


def _telemetry_payload(user: str) -> Dict[str, Any]:
    s = snapshot()
    return {
        "type": "tick",
        "timestamp": time.time(),
        "cpuRam": s["cpuRam"],
        "gpu": s["gpu"],
        "thermal": s["thermal"],
        "docker": s["docker"],
        "storageNetwork": s["storageNetwork"],
        # La vue d'ensemble complète (tuiles, santé, alertes, mode, historique).
        "overview": build_overview(s),
    }


# ------------------------------------------------------------ fichiers statiques


@app.exception_handler(404)
async def spa_fallback(request: Request, exc):
    """Les routes inconnues hors /api renvoient l'application (routage côté client)."""
    if request.url.path.startswith(("/api", "/ws")):
        # Ce gestionnaire attrape aussi les 404 volontaires des routes (« conteneur
        # introuvable », « section inconnue »…). On conserve leur message : le
        # remplacer par « Route inconnue » masquerait la vraie cause à l'écran.
        detail = getattr(exc, "detail", None)
        if not detail or detail == "Not Found":   # 404 de Starlette, pas d'une route
            detail = "Route inconnue"
        return JSONResponse({"detail": detail}, status_code=404)
    index = os.path.join(BASE_DIR, "dist", "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return JSONResponse(
        {"detail": "Interface non compilée. Lancez `npm run build`."}, status_code=404)


dist_dir = os.path.join(BASE_DIR, "dist")
if os.path.isdir(dist_dir):
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="spa")
else:
    log.warning("dossier dist/ absent : seule l'API est servie")
