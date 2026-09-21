"""Écriture sûre des fichiers de configuration modifiés depuis l'interface.

Trois précautions, et elles ne sont pas décoratives :

1. **La propriété des fichiers est préservée.** Le conteneur tourne en root ;
   une écriture naïve (`os.replace` d'un fichier temporaire) donnerait `root:root`
   au `.env` et aux YAML, et `lux` ne pourrait plus les éditer à la main depuis
   l'hôte. On relève donc `st_uid`/`st_gid`/`st_mode` de l'original et on les
   réapplique au remplaçant avant la bascule.

2. **L'écriture est atomique.** Fichier temporaire dans le même répertoire, puis
   `os.replace`. Une coupure de courant au mauvais moment ne laisse jamais un
   `.env` tronqué — ce qui empêcherait la stack de redémarrer.

3. **Une sauvegarde précède chaque écriture.** `<fichier>.bak-<horodatage>`, les
   dix dernières conservées. C'est le filet quand un réglage tourne mal.
"""

from __future__ import annotations

import errno
import logging
import os
import re
import shutil
import time
from typing import Dict, List, Optional, Tuple

log = logging.getLogger("wopr.confwrite")

BACKUPS_KEPT = 10
_BACKUP_RE = re.compile(r"\.bak-\d{8}T\d{6}$")


# --------------------------------------------------------------------- écriture


def _owner_of(path: str) -> Optional[Tuple[int, int, int]]:
    """(uid, gid, mode) du fichier, ou du répertoire parent s'il n'existe pas encore."""
    for candidate in (path, os.path.dirname(path) or "."):
        try:
            st = os.stat(candidate)
        except FileNotFoundError:
            continue
        mode = st.st_mode & 0o777
        if candidate != path:
            # Hérité d'un répertoire : on ne reprend pas le bit d'exécution.
            mode &= 0o666
        return st.st_uid, st.st_gid, mode
    return None


def atomic_write(path: str, data: str, *, mode: Optional[int] = None) -> None:
    """Remplace `path` par `data` sans changer son propriétaire ni ses droits."""
    owner = _owner_of(path)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())

    if owner is not None:
        uid, gid, existing_mode = owner
        try:
            os.chown(tmp, uid, gid)
        except PermissionError:
            log.warning("propriété de %s non reprise (droits insuffisants)", path)
        try:
            os.chmod(tmp, mode if mode is not None else existing_mode)
        except PermissionError:
            log.warning("droits de %s non repris", path)
    elif mode is not None:
        os.chmod(tmp, mode)

    try:
        os.replace(tmp, path)
    except OSError as exc:
        # Le `.env` est monté seul (`./.env:/host-env`) : son point de montage est
        # épinglé par le noyau et ne peut pas être remplacé par un renommage —
        # `os.replace` répond EBUSY. On réécrit alors le fichier en place, ce qui
        # conserve de fait l'inode, le propriétaire et les droits. On y perd
        # l'atomicité, d'où la sauvegarde .bak systématique juste avant.
        if exc.errno not in (errno.EBUSY, errno.EXDEV, errno.EPERM, errno.EINVAL):
            raise
        with open(path, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.unlink(tmp)
        except OSError:
            pass
        log.debug("%s réécrit en place (point de montage épinglé)", path)
    log.info("configuration écrite : %s", path)


def backup(path: str) -> Optional[str]:
    """Copie datée du fichier avant modification. Renvoie le chemin, ou None."""
    if not os.path.exists(path):
        return None
    stamp = time.strftime("%Y%m%dT%H%M%S")
    dest = f"{path}.bak-{stamp}"
    try:
        shutil.copy2(path, dest)
    except Exception:
        log.exception("sauvegarde de %s impossible", path)
        return None
    _prune_backups(path)
    return dest


def list_backups(path: str) -> List[Dict[str, object]]:
    directory = os.path.dirname(path) or "."
    prefix = os.path.basename(path) + ".bak-"
    out: List[Dict[str, object]] = []
    try:
        names = os.listdir(directory)
    except OSError:
        return out
    for name in names:
        if not name.startswith(prefix):
            continue
        full = os.path.join(directory, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({"name": name, "path": full, "size": st.st_size, "at": st.st_mtime})
    out.sort(key=lambda b: b["at"], reverse=True)
    return out


def _prune_backups(path: str) -> None:
    for old in list_backups(path)[BACKUPS_KEPT:]:
        try:
            os.remove(str(old["path"]))
        except OSError:
            pass


# ------------------------------------------------------------------- fichier .env


def _needs_quotes(value: str) -> bool:
    # `$` : docker compose y verrait une interpolation — c'est le cas de toutes
    # les empreintes scrypt de WOPR_USERS. `#` : début de commentaire. Espaces et
    # chaîne vide : ambigus. Dans le doute, on entoure d'apostrophes simples, qui
    # n'interprètent rien.
    return value == "" or bool(re.search(r"[\s$#'\"`\\]", value))


def format_dotenv_value(value: str) -> str:
    if not _needs_quotes(value):
        return value
    if "'" in value:
        # Une apostrophe ne peut pas être échappée à l'intérieur d'apostrophes :
        # on referme, on en insère une échappée, on rouvre.
        value = value.replace("'", "'\\''")
    return f"'{value}'"


def read_dotenv(path: str) -> Dict[str, str]:
    """Valeurs déclarées dans un fichier .env, apostrophes retirées."""
    out: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return out
    for line in lines:
        key, value = _parse_dotenv_line(line)
        if key is not None:
            out[key] = value
    return out


def _parse_dotenv_line(line: str) -> Tuple[Optional[str], str]:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None, ""
    key, _, raw = stripped.partition("=")
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        return None, ""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1]
    return key, raw


def write_dotenv(path: str, updates: Dict[str, str]) -> None:
    """Met à jour les clés indiquées, en laissant le reste du fichier intact.

    Commentaires, ordre et lignes inconnues sont préservés : le `.env` du wopr est
    largement commenté, et ces commentaires sont la documentation de la stack.
    Une clé absente du fichier est ajoutée à la fin.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []

    remaining = dict(updates)
    out: List[str] = []
    for line in lines:
        key, _ = _parse_dotenv_line(line)
        if key is not None and key in remaining:
            out.append(f"{key}={format_dotenv_value(remaining.pop(key))}\n")
        else:
            out.append(line)

    if remaining:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append("\n# Ajouté depuis l'onglet Paramètres du dashboard.\n")
        for key, value in remaining.items():
            out.append(f"{key}={format_dotenv_value(value)}\n")

    backup(path)
    atomic_write(path, "".join(out), mode=0o600)


# ------------------------------------------------------------- YAML commentés

# `thresholds.yaml` et `modes.yaml` sont abondamment commentés, et ces commentaires
# sont la documentation de la stack. Les réécrire avec PyYAML les effacerait.
# ruamel.yaml fait un aller-retour qui les conserve ; s'il manque, on retombe sur
# PyYAML en prévenant, plutôt que de refuser l'enregistrement.
try:
    from ruamel.yaml import YAML as _RuamelYAML

    _ruamel = _RuamelYAML()
    _ruamel.preserve_quotes = True
    _ruamel.width = 100
    _ruamel.indent(mapping=2, sequence=4, offset=2)
except Exception:  # pragma: no cover
    _ruamel = None


def yaml_round_trip_available() -> bool:
    return _ruamel is not None


def load_yaml(path: str):
    """Charge un YAML en conservant, si possible, commentaires et mise en forme."""
    if _ruamel is not None:
        with open(path, "r", encoding="utf-8") as f:
            return _ruamel.load(f) or {}
    import yaml as _pyyaml
    with open(path, "r", encoding="utf-8") as f:
        return _pyyaml.safe_load(f) or {}


def dump_yaml(data) -> str:
    if _ruamel is not None:
        import io
        buf = io.StringIO()
        _ruamel.dump(data, buf)
        return buf.getvalue()
    log.warning("ruamel.yaml absent : les commentaires du fichier seront perdus")
    import yaml as _pyyaml
    return _pyyaml.safe_dump(data, allow_unicode=True, sort_keys=False,
                             default_flow_style=False)


def write_yaml(path: str, data) -> None:
    backup(path)
    atomic_write(path, dump_yaml(data))
