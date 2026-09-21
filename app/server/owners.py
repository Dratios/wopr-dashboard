"""Identités des administrateurs de la machine.

Qui possède quoi n'est pas une affaire de code. Ce serveur est partagé par deux
personnes, il pourrait en compter trois, et leurs noms n'ont rien à faire dans
les sources : ils sont **déclarés dans `config/owners.yaml`**, au même titre que
les modes et les seuils.

L'étiquette Docker `com.wopr.owner` reste la seule source d'autorité sur
l'appartenance d'un conteneur (cf. §4.2 de `wopr-server-rules.md`). Ce fichier
ne sert qu'à deux choses :

1. **deviner** le propriétaire d'un conteneur qui ne porte pas l'étiquette, à
   partir de fragments de son nom ou de son image (`hints`) ;
2. **nommer et colorer** les identités dans l'interface, qui ne connaît donc
   aucun compte en dur.

L'identité `shared` (« partagé ») existe toujours : c'est le repli quand aucune
règle ne tranche. Si le fichier est absent ou illisible, on retombe sur une
configuration minimale à un seul administrateur — le dashboard démarre, il
affiche simplement tout comme partagé.

Le fichier est relu à chaud dès que sa date de modification change : éditer
`owners.yaml` ne demande ni redémarrage ni reconstruction de l'image.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import yaml

log = logging.getLogger("wopr.owners")

CONFIG_DIR = os.environ.get("WOPR_CONFIG_DIR", "/config")
OWNERS_PATH = os.path.join(CONFIG_DIR, "owners.yaml")

# Identité de repli, toujours présente : un conteneur qu'aucune règle ne
# rattache à quelqu'un est « partagé », jamais attribué au hasard.
SHARED_ID = "shared"

# Teintes admises. La liste est fermée parce que l'interface associe chaque
# teinte à des classes Tailwind écrites en toutes lettres : une valeur inventée
# ici ne produirait aucun style. Une teinte inconnue retombe sur « slate ».
TONES = ("cyan", "purple", "emerald", "amber", "rose", "sky", "slate")


@dataclass(frozen=True)
class Owner:
    """Une identité d'administrateur, telle que l'interface l'affiche."""

    id: str
    label: str
    tone: str = "slate"
    description: str = ""
    # Une ligne affichée sous le compteur de la vue Docker. Facultative : sans
    # elle, la carte se contente des chiffres.
    blurb: str = ""
    hints: Sequence[str] = field(default_factory=tuple)

    def as_payload(self) -> Dict[str, str]:
        """Forme envoyée au frontend. Les `hints` restent côté serveur : ils ne
        disent rien à l'interface et révèlent l'inventaire de la machine."""
        return {
            "id": self.id,
            "label": self.label,
            "tone": self.tone,
            "description": self.description or f"Appartient à {self.label}",
            "blurb": self.blurb,
        }


# Configuration minimale, utilisée tant qu'aucun `owners.yaml` n'est lisible.
_FALLBACK: List[Owner] = [
    Owner(id="admin", label="@admin", tone="cyan", description="Appartient à l'administrateur"),
    Owner(id=SHARED_ID, label="Partagé", tone="emerald",
          description="Partagé (accessible / utilisé par tous)"),
]

_lock = threading.RLock()
_cache: Optional[List[Owner]] = None
_cache_scope: frozenset = frozenset()
_cache_mtime: Optional[float] = None


def _parse_out_of_scope(raw: object) -> frozenset:
    """Stacks que le dashboard affiche mais sur lesquelles il refuse d'agir.

    Déclarées ici, et non dans le code, pour la même raison que les identités :
    ce sont des noms propres à une machine (§5 de `wopr-server-rules.md`).
    """
    entries = raw.get("outOfScopeStacks") if isinstance(raw, dict) else None
    if entries is None:
        return frozenset()
    if not isinstance(entries, list):
        log.warning("owners.yaml : `outOfScopeStacks` n'est pas une liste, ignoré")
        return frozenset()
    return frozenset(str(e).strip() for e in entries if str(e).strip())


def _parse(raw: object) -> List[Owner]:
    """Traduit le YAML en identités, en ignorant ce qui n'est pas exploitable.

    Une entrée mal formée est écartée avec un avertissement plutôt que de faire
    échouer tout le chargement : une faute de frappe dans le fichier ne doit pas
    priver le dashboard de sa vue Docker.
    """
    if not isinstance(raw, dict):
        raise ValueError("le fichier doit contenir un dictionnaire")

    entries = raw.get("owners")
    if not isinstance(entries, list):
        raise ValueError("clé `owners` absente ou non liste")

    owners: List[Owner] = []
    seen: set = set()
    for entry in entries:
        if not isinstance(entry, dict):
            log.warning("owners.yaml : entrée ignorée (ce n'est pas un bloc)")
            continue

        oid = str(entry.get("id") or "").strip().lower()
        if not oid:
            log.warning("owners.yaml : entrée sans `id`, ignorée")
            continue
        if oid in seen:
            log.warning("owners.yaml : identité `%s` en double, seule la première compte", oid)
            continue
        seen.add(oid)

        tone = str(entry.get("tone") or "slate").strip().lower()
        if tone not in TONES:
            log.warning("owners.yaml : teinte `%s` inconnue pour `%s`, repli sur slate", tone, oid)
            tone = "slate"

        hints = entry.get("hints") or []
        if not isinstance(hints, list):
            log.warning("owners.yaml : `hints` de `%s` n'est pas une liste, ignorés", oid)
            hints = []

        owners.append(Owner(
            id=oid,
            label=str(entry.get("label") or f"@{oid}").strip(),
            tone=tone,
            description=str(entry.get("description") or "").strip(),
            blurb=str(entry.get("blurb") or "").strip(),
            hints=tuple(str(h).strip().lower() for h in hints if str(h).strip()),
        ))

    if not owners:
        raise ValueError("aucune identité exploitable")

    # `shared` est structurel : l'ajouter s'il manque évite d'avoir à traiter
    # partout ailleurs le cas « aucun repli disponible ».
    if not any(o.id == SHARED_ID for o in owners):
        owners.append(Owner(id=SHARED_ID, label="Partagé", tone="emerald",
                            description="Partagé (accessible / utilisé par tous)"))
    return owners


def _load() -> tuple:
    try:
        with open(OWNERS_PATH, encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        return _parse(raw), _parse_out_of_scope(raw)
    except FileNotFoundError:
        log.info("owners.yaml absent (%s) : configuration minimale", OWNERS_PATH)
    except Exception as exc:
        log.warning("owners.yaml illisible (%s) : %s — configuration minimale", OWNERS_PATH, exc)
    return list(_FALLBACK), frozenset()


def all() -> List[Owner]:  # noqa: A001 — « all » est le nom juste ici
    """Identités déclarées, relues si le fichier a changé depuis le dernier appel."""
    global _cache, _cache_scope, _cache_mtime
    try:
        mtime: Optional[float] = os.path.getmtime(OWNERS_PATH)
    except OSError:
        mtime = None

    with _lock:
        if _cache is None or mtime != _cache_mtime:
            _cache, _cache_scope = _load()
            _cache_mtime = mtime
        return _cache


def reload() -> List[Owner]:
    """Force une relecture (appelée après une écriture depuis l'interface)."""
    global _cache, _cache_mtime
    with _lock:
        _cache = None
        _cache_mtime = None
    return all()


def out_of_scope() -> frozenset:
    """Noms de stacks hors périmètre, tels que déclarés dans `owners.yaml`."""
    all()  # force la relecture si le fichier a changé
    with _lock:
        return _cache_scope


def ids() -> List[str]:
    return [o.id for o in all()]


def labels() -> Dict[str, str]:
    return {o.id: o.label for o in all()}


def payload() -> List[Dict[str, str]]:
    """Ce que `/api/status` transmet à l'interface pour qu'elle se dessine."""
    return [o.as_payload() for o in all()]


def is_known(owner_id: str) -> bool:
    return owner_id in ids()


def admins() -> List[Owner]:
    """Les identités nominatives, sans le repli « partagé »."""
    return [o for o in all() if o.id != SHARED_ID]


def resolve(*fragments: str) -> str:
    """Devine une identité à partir du nom et de l'image d'un conteneur.

    N'est consulté que lorsque l'étiquette `com.wopr.owner` est absente. Les
    identités sont examinées dans l'ordre du fichier : la première dont un
    `hint` apparaît dans le texte l'emporte, ce qui permet de placer une règle
    spécifique avant une règle générale. Sans correspondance : « partagé ».
    """
    haystack = " ".join(f for f in fragments if f).lower()
    for owner in all():
        if owner.id == SHARED_ID:
            continue
        if any(h in haystack for h in owner.hints):
            return owner.id
    # Le repli peut lui aussi porter des indices (bases de données, proxys…),
    # mais il est de toute façon la réponse par défaut.
    return SHARED_ID
