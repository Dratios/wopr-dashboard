"""Supervision et pilotage des conteneurs Docker de l'hôte.

Deux écarts avec la version d'origine méritent d'être signalés :

- Les statistiques par conteneur y valaient toujours `cpuPct: 0.0` et `memMiB: 0` :
  les champs existaient, personne ne les remplissait. Ici un thread par conteneur
  suit le flux `stats` du démon et tient à jour les vraies valeurs.
- Les actions de stack agissaient conteneur par conteneur, ce qui ne fait pas un
  `compose down` (réseaux et volumes restaient) et rendait `pull` impossible. On
  passe maintenant par `docker compose`, retrouvé via les étiquettes que Compose
  pose lui-même sur les conteneurs.
"""

from __future__ import annotations

import calendar
import logging
import re
import threading
import time
from typing import Any, Dict, List, Optional

import docker

from . import owners
from .hostexec import host

log = logging.getLogger("wopr.docker")

# Stacks hors périmètre du dashboard (§5 de wopr-server-rules.md) : affichées,
# mais leurs actions sont refusées côté API. Déclarées dans `config/owners.yaml`
# afin que le code ne nomme aucune stack de cette machine en particulier.
def out_of_scope_stacks() -> set:
    return owners.out_of_scope()


def _own_container_id() -> Optional[str]:
    """Identifiant complet du conteneur dans lequel tourne le dashboard.

    Avec `network_mode: host`, le nom d'hôte est celui de la machine et ne dit rien.
    Docker monte en revanche /etc/hostname, /etc/hosts et /etc/resolv.conf depuis
    /var/lib/docker/containers/<id>/ : l'identifiant se lit dans mountinfo.
    Hors conteneur (dev local), renvoie None et rien n'est considéré comme « soi ».
    """
    try:
        with open("/proc/self/mountinfo", encoding="utf-8") as f:
            match = re.search(r"/containers/([0-9a-f]{64})/", f.read())
    except OSError:
        return None
    return match.group(1) if match else None


SELF_CONTAINER_ID = _own_container_id()

# Actions refusées sur le dashboard lui-même : une fois arrêté, en pause ou
# supprimé, il ne peut plus être relancé depuis sa propre interface. `up` sur sa
# stack peut recréer le conteneur, ce qui tue en route le `docker compose` qui
# s'en charge — à faire depuis un shell sur wopr.
SELF_FORBIDDEN_CONTAINER_ACTIONS = {"stop", "pause", "delete"}
SELF_FORBIDDEN_STACK_ACTIONS = {"down", "up"}


class StatsCollector:
    """Suit le flux `stats` de chaque conteneur en cours d'exécution.

    Le démon Docker n'expose la consommation CPU que sous forme de compteurs
    cumulés ; le pourcentage est la dérivée entre deux échantillons. Un appel
    ponctuel coûte une à deux secondes par conteneur, ce qui serait trop lent pour
    rafraîchir un tableau de bord — d'où un flux persistant par conteneur.
    """

    def __init__(self, client) -> None:
        self.client = client
        self._values: Dict[str, Dict[str, Any]] = {}
        self._threads: Dict[str, threading.Thread] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._supervisor: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._supervisor is not None:
            return

        def supervise() -> None:
            while not self._stop.wait(10.0):
                try:
                    self._sync()
                except Exception:
                    log.exception("supervision des flux de statistiques en échec")

        self._sync()
        self._supervisor = threading.Thread(target=supervise, name="wopr-stats", daemon=True)
        self._supervisor.start()

    def _sync(self) -> None:
        try:
            running = {c.id: c for c in self.client.containers.list()}
        except Exception:
            return

        with self._lock:
            for cid in list(self._threads):
                if cid not in running:
                    self._threads.pop(cid, None)
                    self._values.pop(cid, None)

            for cid, container in running.items():
                if cid in self._threads:
                    continue
                t = threading.Thread(
                    target=self._follow, args=(cid, container),
                    name=f"wopr-stats-{cid[:12]}", daemon=True,
                )
                self._threads[cid] = t
                t.start()

    def _follow(self, cid: str, container) -> None:
        try:
            for sample in container.stats(stream=True, decode=True):
                if self._stop.is_set():
                    return
                parsed = self._parse(sample)
                if parsed:
                    with self._lock:
                        self._values[cid] = parsed
        except Exception:
            # Conteneur arrêté ou flux coupé : le superviseur relancera si besoin.
            pass
        finally:
            with self._lock:
                self._threads.pop(cid, None)

    @staticmethod
    def _parse(sample: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            cpu = sample.get("cpu_stats", {})
            precpu = sample.get("precpu_stats", {})
            cpu_total = cpu.get("cpu_usage", {}).get("total_usage", 0)
            pre_total = precpu.get("cpu_usage", {}).get("total_usage", 0)
            system = cpu.get("system_cpu_usage", 0)
            pre_system = precpu.get("system_cpu_usage", 0)

            cpu_delta = cpu_total - pre_total
            system_delta = system - pre_system
            online = cpu.get("online_cpus") or len(
                cpu.get("cpu_usage", {}).get("percpu_usage") or []) or 1

            cpu_pct = 0.0
            if cpu_delta > 0 and system_delta > 0:
                cpu_pct = (cpu_delta / system_delta) * online * 100.0

            mem = sample.get("memory_stats", {})
            usage = mem.get("usage", 0)
            # Le cache de pages est comptabilisé dans `usage` mais n'est pas de la
            # mémoire réellement utilisée par le processus : Docker le retranche
            # pour l'affichage de `docker stats`, on fait pareil.
            inactive = (mem.get("stats") or {}).get("inactive_file", 0)
            mem_used = max(0, usage - inactive)
            limit = mem.get("limit") or 0

            net_rx = net_tx = 0
            for iface in (sample.get("networks") or {}).values():
                net_rx += iface.get("rx_bytes", 0)
                net_tx += iface.get("tx_bytes", 0)

            return {
                "cpuPct": round(cpu_pct, 1),
                "memMiB": round(mem_used / (1024 ** 2)),
                "memLimitMiB": round(limit / (1024 ** 2)) if limit else None,
                "netRxBytes": net_rx,
                "netTxBytes": net_tx,
                "at": time.time(),
            }
        except Exception:
            return None

    def get(self, cid: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._values.get(cid, {}))

    def stop(self) -> None:
        self._stop.set()


class DockerManager:
    def __init__(self) -> None:
        self.client = None
        self.error: Optional[str] = None
        self.stats: Optional[StatsCollector] = None
        self._connect()

    def _connect(self) -> bool:
        try:
            self.client = docker.from_env()
            self.client.ping()
            self.error = None
            if self.stats is None:
                self.stats = StatsCollector(self.client)
                self.stats.start()
            return True
        except Exception as exc:
            self.client = None
            self.error = f"démon Docker injoignable : {exc}"
            log.warning(self.error)
            return False

    def is_available(self) -> bool:
        if self.client is None:
            return self._connect()
        return True

    # ------------------------------------------------------------------ lecture

    @staticmethod
    def _image_name(container) -> str:
        """Image telle que référencée à la création du conteneur.

        Lue dans ses propres attributs plutôt que via `container.image`, qui
        interroge Docker sur l'image elle-même : si celle-ci a été supprimée
        (`image prune`, nouvelle version tirée), l'appel lève ImageNotFound et
        faisait échouer toute la vue Docker — et avec elle la vue d'ensemble,
        les alertes et la télémétrie.
        """
        return (container.attrs.get("Config", {}).get("Image")
                or container.attrs.get("Image", "")[len("sha256:"):][:12]
                or "image inconnue")

    @staticmethod
    def _owner(container) -> str:
        """Identité à laquelle rattacher un conteneur.

        L'étiquette explicite fait foi ; à défaut, `config/owners.yaml` sert à
        deviner. Une étiquette qui ne correspond à aucune identité déclarée est
        ignorée plutôt que reprise telle quelle : l'interface ne saurait pas
        l'afficher, et une valeur arbitraire posée sur un conteneur ne doit pas
        traverser l'API.
        """
        labels = container.labels or {}
        for key in ("com.wopr.owner", "wopr.owner"):
            value = (labels.get(key) or "").strip().lower()
            if owners.is_known(value):
                return value

        return owners.resolve(container.name, DockerManager._image_name(container))

    def get_docker_data(self) -> Dict[str, Any]:
        if not self.is_available():
            return {
                "available": False,
                "unavailableReason": self.error,
                "summary": {"running": 0, "total": 0, "unhealthy": 0, "recentRestarts": 0},
                "stacks": [],
            }

        try:
            containers = self.client.containers.list(all=True)
        except Exception as exc:
            self.client = None
            return {
                "available": False,
                "unavailableReason": f"listing impossible : {exc}",
                "summary": {"running": 0, "total": 0, "unhealthy": 0, "recentRestarts": 0},
                "stacks": [],
            }

        stacks: Dict[str, Dict[str, Any]] = {}
        running = unhealthy = restarts = 0
        now = time.time()

        # Lu une fois pour toute la passe : `owners` relit son fichier à chaud,
        # inutile de le refaire pour chacun des conteneurs.
        out_of_scope = owners.out_of_scope()

        for c in containers:
            attrs = c.attrs or {}
            labels = c.labels or {}
            state_attrs = attrs.get("State", {})

            status = (c.status or "").lower()
            if status == "running":
                ui_state = "running"
                running += 1
            elif status == "restarting":
                ui_state = "restarting"
                unhealthy += 1
            elif status == "paused":
                # Distinct d'« arrêté » : il se relance par `unpause`, pas `start`.
                ui_state = "paused"
            elif status in ("exited", "dead", "created"):
                ui_state = "stopped"
            else:
                ui_state = "unhealthy"
                unhealthy += 1

            health = "none"
            if "Health" in state_attrs:
                raw = state_attrs["Health"].get("Status", "none")
                health = {"healthy": "healthy", "unhealthy": "unhealthy",
                          "starting": "starting"}.get(raw, "none")
                if health == "unhealthy" and ui_state == "running":
                    unhealthy += 1

            restart_count = state_attrs.get("RestartCount", 0) or 0
            restarts += restart_count

            uptime = 0
            started = state_attrs.get("StartedAt")
            if status == "running" and started:
                try:
                    # Docker renvoie un horodatage RFC3339 à précision nanoseconde,
                    # que `fromisoformat` ne sait pas lire tel quel.
                    trimmed = started[:26].rstrip("Z")
                    if "." in trimmed:
                        base, frac = trimmed.split(".")
                        trimmed = f"{base}.{frac[:6]}"
                    from datetime import datetime, timezone
                    dt = datetime.fromisoformat(trimmed).replace(tzinfo=timezone.utc)
                    uptime = max(0, int(now - dt.timestamp()))
                except Exception:
                    uptime = 0

            ports: List[str] = []
            for container_port, bindings in (attrs.get("NetworkSettings", {})
                                             .get("Ports", {}) or {}).items():
                for b in bindings or []:
                    host_ip = b.get("HostIp") or ""
                    prefix = f"{host_ip}:" if host_ip not in ("", "0.0.0.0", "::") else ""
                    ports.append(f"{prefix}{b.get('HostPort')}→{container_port}")

            host_config = attrs.get("HostConfig", {})
            uses_gpu: List[int] = []
            for d in host_config.get("DeviceRequests") or []:
                caps = d.get("Capabilities") or [[]]
                if d.get("Driver") == "nvidia" or any("gpu" in c for c in caps):
                    ids = d.get("DeviceIDs") or []
                    numeric = [int(x) for x in ids if str(x).isdigit()]
                    uses_gpu = numeric or [0]

            live = self.stats.get(c.id) if self.stats else {}

            stack_name = labels.get("com.docker.compose.project", "sans stack")
            owner = self._owner(c)

            container_data = {
                "id": c.short_id,
                "fullId": c.id,
                "isSelf": c.id == SELF_CONTAINER_ID,
                "name": c.name.lstrip("/"),
                "service": labels.get("com.docker.compose.service", c.name),
                "image": self._image_name(c),
                "state": ui_state,
                "health": health,
                "cpuPct": live.get("cpuPct"),
                "memMiB": live.get("memMiB"),
                "memLimitMiB": live.get("memLimitMiB"),
                "uptimeSeconds": uptime,
                "ports": ports,
                "managedBy": ("jarvis" if labels.get("com.wopr.managed-by") == "jarvis"
                              else "compose" if "com.docker.compose.project" in labels
                              else "manual"),
                "owner": owner,
                "usesGpu": uses_gpu or None,
                "restarts": restart_count,
                "privileged": bool(host_config.get("Privileged")),
                "restartPolicy": (host_config.get("RestartPolicy") or {}).get("Name"),
                "networkMode": host_config.get("NetworkMode"),
                "volumes": [m.get("Destination") for m in attrs.get("Mounts", [])
                            if m.get("Destination")],
                # Les variables d'environnement contiennent des jetons et mots de
                # passe (on en a vu dans les stacks existantes) : on ne renvoie que
                # les noms, jamais les valeurs.
                "envKeys": sorted({
                    e.split("=", 1)[0]
                    for e in (attrs.get("Config", {}).get("Env") or []) if "=" in e
                }),
            }

            if stack_name not in stacks:
                stacks[stack_name] = {
                    "name": stack_name,
                    "owner": owner,
                    "outOfScope": stack_name in out_of_scope,
                    "containsSelf": False,
                    "configFiles": labels.get("com.docker.compose.project.config_files"),
                    "workingDir": labels.get("com.docker.compose.project.working_dir"),
                    "containers": [],
                }
            stacks[stack_name]["containers"].append(container_data)
            if container_data["isSelf"]:
                stacks[stack_name]["containsSelf"] = True

        for stack in stacks.values():
            # Pas `owners` : ce nom est celui du module importé plus haut, et une
            # affectation locale le masquerait dans toute la fonction.
            stack_owners = {c["owner"] for c in stack["containers"]}
            stack["owner"] = (stack_owners.pop() if len(stack_owners) == 1
                              else owners.SHARED_ID)
            stack["containers"].sort(key=lambda c: c["name"])

        return {
            "available": True,
            "unavailableReason": None,
            "summary": {
                "running": running,
                "total": len(containers),
                "unhealthy": unhealthy,
                "recentRestarts": restarts,
            },
            "stacks": sorted(stacks.values(), key=lambda s: s["name"]),
        }

    def get_logs(self, container_id: str, tail: int = 200) -> List[Dict[str, str]]:
        if not self.is_available():
            return []
        try:
            container = self.client.containers.get(container_id)
            raw = container.logs(tail=tail, timestamps=True).decode("utf-8", errors="replace")
        except Exception:
            return []

        out: List[Dict[str, str]] = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            parts = line.split(" ", 1)
            stamp, message = (parts[0], parts[1]) if len(parts) > 1 else ("", line)
            time_str = self._local_time(stamp)

            lowered = message.lower()
            if any(k in lowered for k in ("error", "erreur", "fatal", "exception",
                                          "traceback", "panic", "failed")):
                level = "err"
            elif any(k in lowered for k in ("warn", "attention", "deprecat")):
                level = "warn"
            else:
                level = "info"

            out.append({"time": time_str, "level": level, "message": message})
        return out

    @staticmethod
    def _local_time(stamp: str) -> str:
        """`2026-09-15T10:04:05.123456789Z` → `12:04:05` à l'heure locale.

        Docker horodate en UTC ; le reste de l'interface est à l'heure de Paris.
        Afficher la partie brute décalait les journaux de deux heures en été.
        """
        if len(stamp) < 19:
            return ""
        try:
            parsed = time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")
            return time.strftime("%H:%M:%S", time.localtime(calendar.timegm(parsed)))
        except ValueError:
            return stamp[11:19]

    # ------------------------------------------------------------------ actions

    def container_action(self, container_id: str, action: str) -> bool:
        if not self.is_available():
            return False
        try:
            container = self.client.containers.get(container_id)
        except Exception:
            log.warning("conteneur introuvable : %s", container_id)
            return False

        try:
            if action == "start":
                container.start()
            elif action == "stop":
                container.stop(timeout=15)
            elif action == "restart":
                container.restart(timeout=15)
            elif action == "pause":
                container.pause()
            elif action == "unpause":
                container.unpause()
            elif action == "delete":
                container.remove(force=True)
            else:
                return False
            return True
        except Exception:
            log.exception("action %s impossible sur %s", action, container_id)
            return False

    def stack_info(self, stack_name: str) -> Optional[Dict[str, Any]]:
        if not self.is_available():
            return None
        try:
            containers = self.client.containers.list(
                all=True,
                filters={"label": f"com.docker.compose.project={stack_name}"},
            )
        except Exception:
            return None
        if not containers:
            return None
        labels = containers[0].labels or {}
        return {
            "configFiles": labels.get("com.docker.compose.project.config_files"),
            "workingDir": labels.get("com.docker.compose.project.working_dir"),
            "containers": containers,
        }

    def self_stack_dir(self) -> Optional[str]:
        """Dossier hôte de la stack du dashboard, lu sur son propre conteneur.

        Compose y pose `com.docker.compose.project.working_dir`. C'est plus sûr
        qu'un chemin écrit dans le code : la commande de recréation affichée par
        l'interface reste juste même si la stack est déplacée. `None` si le
        dashboard ne tourne pas dans un conteneur, ou pas via compose.
        """
        if not (self.is_available() and SELF_CONTAINER_ID):
            return None
        try:
            container = self.client.containers.get(SELF_CONTAINER_ID)
        except Exception:
            return None
        return (container.labels or {}).get("com.docker.compose.project.working_dir") or None

    def stack_action(self, stack_name: str, action: str) -> tuple[bool, str]:
        """Agit sur une stack entière via `docker compose`.

        Nécessite que les fichiers compose soient lisibles là où la commande
        s'exécute — d'où le passage par `nsenter`, qui la lance dans les
        namespaces de l'hôte plutôt que dans ceux du conteneur.
        """
        if stack_name in owners.out_of_scope():
            return False, f"la stack « {stack_name} » est hors du périmètre du dashboard"

        info = self.stack_info(stack_name)
        if not info:
            return False, f"stack « {stack_name} » introuvable"

        verbs = {
            "up": ["up", "-d"],
            "down": ["down"],
            "restart": ["restart"],
            "pull": ["pull"],
        }
        if action not in verbs:
            return False, f"action « {action} » inconnue"

        config_files = info["configFiles"]
        working_dir = info["workingDir"]

        if not config_files or not working_dir:
            # Stack lancée sans Compose, ou étiquettes absentes : on se rabat sur
            # une action conteneur par conteneur, en le disant clairement.
            if action == "pull":
                return False, "fichier compose introuvable : `pull` impossible"
            ok = True
            for c in info["containers"]:
                ok = self.container_action(c.id, {"up": "start", "down": "stop"}
                                           .get(action, action)) and ok
            return ok, ("appliqué conteneur par conteneur "
                        "(fichier compose introuvable, réseaux et volumes conservés)")

        # On exécute le `docker compose` **de l'hôte**, dans son espace de montage :
        # les chemins des fichiers compose sont alors valides tels quels, sans avoir
        # à monter les dossiers de stacks dans le conteneur ni à embarquer le CLI
        # dans l'image.
        args = ["compose"]
        for path in config_files.split(","):
            args += ["-f", path.strip()]
        args += ["--project-directory", working_dir, "-p", stack_name] + verbs[action]

        res = host.run("docker", args, timeout=300)
        if res.ok:
            return True, f"`docker compose {action}` exécuté"
        detail = (res.stderr or res.stdout).strip().splitlines()
        return False, detail[-1] if detail else f"code de sortie {res.code}"

    def shutdown(self) -> None:
        if self.stats:
            self.stats.stop()
