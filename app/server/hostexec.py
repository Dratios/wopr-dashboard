"""Exécution de commandes sur l'hôte depuis le conteneur.

Le conteneur tourne en `privileged` + `pid: host`, ce qui permet d'entrer dans les
namespaces de PID 1 via `nsenter`. Tout ce qui doit agir sur l'hôte passe par ici,
et uniquement par ici : c'est le seul point du code qui exécute des commandes, donc
le seul endroit à relire pour savoir ce que le dashboard peut faire à la machine.

Chaque commande est validée contre une allowlist explicite. Un binaire absent de
ALLOWED ne sera jamais lancé, même si l'appelant le demande.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import List, Optional, Sequence

log = logging.getLogger("wopr.hostexec")

# Binaires autorisés à être exécutés sur l'hôte, et pourquoi.
ALLOWED = {
    "systemctl": "état et redémarrage des services, reboot",
    "modprobe": "chargement de nct6775 pour les ventilateurs",
    "nvidia-smi": "interrogation GPU de secours si NVML échoue",
    "apt-check": "comptage des mises à jour en attente",
    "apt-get": "simulation de mise à niveau, pour compter les paquets en attente",
    "sync": "vidage du cache disque",
    "renice": "changement de priorité d'un processus",
    "ping": "latence passerelle et Internet",
    "iptables-save": "lecture des règles de filtrage (lecture seule par nature)",
    "nft": "lecture du jeu de règles nftables",
    "ufw": "état du pare-feu",
    "docker": "actions `docker compose` sur les stacks",
    "nvme": "lecture SMART des SSD NVMe (usure, heures, températures)",
}

# Certains binaires de l'allowlist peuvent aussi écrire. On restreint donc leurs
# sous-commandes à ce qui est strictement de la lecture.
VERB_ALLOWLIST = {
    "nft": {"list"},
    "ufw": {"status"},
    "modprobe": {"nct6775"},  # un seul module, celui des ventilateurs
    # `docker` peut tout faire sur le démon ; le dashboard n'en utilise que le
    # sous-ensemble `compose`. Les actions par conteneur passent par le SDK Python
    # sur le socket, pas par ce binaire.
    "docker": {"compose"},
    # `nvme` sait aussi formater et effacer un disque : seule la lecture
    # du journal SMART est autorisée.
    "nvme": {"smart-log", "list"},
    # `apt-get upgrade` installe réellement des paquets : la garde
    # ci-dessous impose en plus le mode simulation (-s).
    "apt-get": {"upgrade"},
}

# Sous-commandes systemctl autorisées. `systemctl` peut tout faire, donc on
# restreint au-delà du nom du binaire.
SYSTEMCTL_VERBS = {
    "show", "status", "is-active", "list-units",   # lecture
    "restart", "reboot",                            # écriture
}


@dataclass
class Result:
    ok: bool
    stdout: str
    stderr: str
    code: int

    @property
    def out(self) -> str:
        return self.stdout.strip()


class HostExec:
    """Lance des commandes dans les namespaces de l'hôte."""

    def __init__(self) -> None:
        # En dehors d'un conteneur (dev local), on exécute directement.
        self.in_container = os.path.exists("/.dockerenv") or os.environ.get("WOPR_IN_CONTAINER") == "1"
        self.nsenter = shutil.which("nsenter")
        self._host_ok: Optional[bool] = None

    def _prefix(self) -> List[str]:
        if self.in_container and self.nsenter:
            # -t 1 : PID 1 de l'hôte (visible grâce à `pid: host`)
            # mount, uts, ipc, net, pid : on veut le système de fichiers et le
            # réseau de l'hôte, pas ceux du conteneur.
            return [self.nsenter, "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"]
        return []

    def available(self) -> bool:
        """L'accès à l'hôte fonctionne-t-il réellement ?

        Testé une seule fois, puis mis en cache. Sert à dire honnêtement à l'UI
        que les actions système sont indisponibles plutôt que de les laisser
        échouer une par une.
        """
        if self._host_ok is None:
            if not self.in_container:
                self._host_ok = True
            else:
                probe = self.run("systemctl", ["is-active", "docker"], timeout=5)
                self._host_ok = probe.code != 127 and bool(probe.out)
        return self._host_ok

    def run(self, binary: str, args: Sequence[str], timeout: float = 20.0) -> Result:
        if binary not in ALLOWED:
            log.warning("commande refusée (hors allowlist) : %s", binary)
            return Result(False, "", f"commande non autorisée : {binary}", 126)

        if binary == "systemctl" and args and args[0] not in SYSTEMCTL_VERBS:
            log.warning("sous-commande systemctl refusée : %s", args[0])
            return Result(False, "", f"sous-commande systemctl non autorisée : {args[0]}", 126)

        allowed_verbs = VERB_ALLOWLIST.get(binary)
        if allowed_verbs is not None and (not args or args[0] not in allowed_verbs):
            verb = args[0] if args else "(aucune)"
            log.warning("sous-commande refusée : %s %s", binary, verb)
            return Result(False, "", f"sous-commande non autorisée : {binary} {verb}", 126)

        if binary == "apt-get" and "-s" not in args:
            log.error("apt-get refusé : le mode simulation (-s) est obligatoire")
            return Result(False, "", "apt-get n'est autorisé qu'en simulation", 126)

        cmd = self._prefix() + [binary] + list(args)
        try:
            p = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout, check=False
            )
            return Result(p.returncode == 0, p.stdout, p.stderr, p.returncode)
        except subprocess.TimeoutExpired:
            return Result(False, "", f"délai dépassé après {timeout}s", 124)
        except FileNotFoundError:
            return Result(False, "", f"binaire introuvable : {binary}", 127)
        except Exception as exc:  # pragma: no cover - défensif
            log.exception("échec d'exécution hôte : %s", cmd)
            return Result(False, "", str(exc), 1)


host = HostExec()
