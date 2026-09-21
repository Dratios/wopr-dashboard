"""Authentification par session pour le dashboard WOPR.

Le dashboard pilote la machine : arrêt de conteneurs, kill de processus, reboot.
Il n'est donc jamais servi sans authentification, même sur le LAN.

Les comptes vivent dans le `.env` du stack sous forme d'empreintes scrypt (jamais
de mot de passe en clair, jamais dans git). `scripts/wopr-passwd.py` les génère.

Un seul compte administrateur est prévu par défaut. Le format accepte plusieurs
entrées si le besoin d'un second compte se présente — il suffit d'ajouter une
paire `nom:empreinte` séparée par une virgule.

La session est un cookie signé (pas chiffré : il ne contient que le nom d'utilisateur
et une date). Signé suffit — on veut empêcher la falsification, pas cacher son propre
nom d'utilisateur à l'utilisateur.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
from typing import Dict, Optional

from fastapi import Cookie, HTTPException, Response, WebSocket
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import owners, settings

log = logging.getLogger("wopr.auth")

COOKIE_NAME = "wopr_session"
# Repli ; la valeur effective vient de l'onglet Paramètres.
SESSION_MAX_AGE = 12 * 3600  # 12 h


def session_max_age() -> int:
    try:
        return int(settings.get("security.sessionMaxAgeH")) * 3600
    except Exception:
        return SESSION_MAX_AGE

# Paramètres scrypt. n=2^14 avec r=8 demande ~16 Mio de mémoire par vérification :
# assez coûteux pour décourager une attaque par dictionnaire, assez rapide pour
# que la connexion reste instantanée.
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_LEN = 32

# scrypt vient de `hashlib`, donc de la bibliothèque standard : le dashboard n'a
# pas de dépendance de hachage à faire suivre, et le script de génération des mots
# de passe tourne avec n'importe quel Python 3.
#
# Format stocké : scrypt$<n>$<r>$<p>$<sel base64>$<empreinte base64>


def hash_password(password: str, *, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN,
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N, SCRYPT_R, SCRYPT_P,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, pp, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        candidate = hashlib.scrypt(
            password.encode("utf-8"), salt=salt,
            n=int(n), r=int(r), p=int(pp), dklen=len(expected),
        )
    except Exception:
        log.error("empreinte de mot de passe illisible dans WOPR_USERS")
        return False
    # Comparaison à temps constant : une comparaison naïve fuirait le préfixe
    # correct, octet par octet.
    return hmac.compare_digest(candidate, expected)


# Empreinte d'une valeur arbitraire, pour brûler le même temps de calcul quand le
# compte demandé n'existe pas : sans elle, la rapidité de la réponse révélerait les
# noms d'utilisateur valides.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def _load_users() -> Dict[str, str]:
    """Comptes du dashboard : `settings.yaml` d'abord, sinon `WOPR_USERS`.

    Le mot de passe se change depuis l'onglet Paramètres, qui écrit l'empreinte
    dans `settings.yaml`. Sans cette couche, il faudrait recréer le conteneur pour
    changer un mot de passe, puisque `WOPR_USERS` vient du `.env`. Le `.env` reste
    la valeur d'amorçage — et le moyen de se dépanner si le fichier de réglages
    devient illisible.
    """
    stored = settings.get_raw("security.users", None)
    if isinstance(stored, dict) and stored:
        users = {str(name): str(digest) for name, digest in stored.items()
                 if str(digest).startswith("scrypt$")}
        if users:
            return users

    raw = os.environ.get("WOPR_USERS", "").strip()
    users: Dict[str, str] = {}
    if not raw:
        return users
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        name, _, digest = entry.partition(":")
        name = name.strip()
        digest = digest.strip()
        if not digest.startswith("scrypt$"):
            log.warning(
                "compte ignoré : empreinte au mauvais format pour %s "
                "(attendu scrypt$…, générez-la avec scripts/wopr-passwd.py)", name)
            continue
        users[name] = digest
    return users


def owner_identity() -> str:
    """Propriétaire auquel correspond la personne aux commandes.

    Le compte de connexion (`admin`) et l'étiquette `com.wopr.owner` posée sur
    les conteneurs sont deux choses distinctes. Cette valeur fait le lien : elle
    dit quels conteneurs sont « les siens », et donc lesquels demandent une
    confirmation renforcée parce qu'ils sont à l'autre administrateur. Les
    identités possibles sont déclarées dans `config/owners.yaml`.

    Une valeur qui n'y figure pas — fichier remanié après coup, faute de frappe —
    retombe sur « partagé » : au pire, tout demande une confirmation renforcée.
    """
    value = str(settings.get("general.ownerIdentity")).strip()
    return value if owners.is_known(value) else owners.SHARED_ID


def _session_salt() -> str:
    """Sel de signature des cookies, incluant l'époque de session.

    Changer le mot de passe incrémente cette époque, ce qui invalide d'un coup
    tous les cookies émis auparavant — y compris après un redémarrage.
    """
    epoch = settings.get_raw("security.sessionEpoch", 0)
    return f"wopr-session-{epoch}" if epoch else "wopr-session"


def _load_secret() -> str:
    secret = os.environ.get("WOPR_SESSION_SECRET", "").strip()
    if not secret:
        # Sans secret stable, les sessions ne survivent pas à un redémarrage.
        # On refuse de démarrer plutôt que de générer un secret silencieusement,
        # ce qui déconnecterait tout le monde à chaque `compose restart`.
        raise RuntimeError(
            "WOPR_SESSION_SECRET absent du .env. "
            "Générez-le avec : python3 -c 'import secrets;print(secrets.token_urlsafe(48))'"
        )
    if len(secret) < 32:
        raise RuntimeError("WOPR_SESSION_SECRET trop court (48 caractères minimum recommandés)")
    return secret


class Auth:
    def __init__(self) -> None:
        self.users = _load_users()
        self.serializer = URLSafeTimedSerializer(_load_secret(), salt=_session_salt())
        # Limitation des tentatives, par utilisateur, en mémoire.
        self._failures: Dict[str, list] = {}
        if not self.users:
            log.error(
                "Aucun compte configuré : WOPR_USERS est vide. "
                "Le dashboard refusera toutes les connexions."
            )

    # ---------------------------------------------------------------- connexion

    def _throttled(self, username: str) -> Optional[int]:
        """Renvoie le nombre de secondes à attendre, ou None si autorisé."""
        try:
            window = int(settings.get("security.loginWindowS"))
            attempts = int(settings.get("security.loginMaxAttempts"))
        except Exception:
            window, attempts = 300, 5
        now = time.time()
        recent = [t for t in self._failures.get(username, []) if now - t < window]
        self._failures[username] = recent
        if len(recent) >= attempts:
            return int(window - (now - recent[0]))
        return None

    def verify(self, username: str, password: str) -> bool:
        wait = self._throttled(username)
        if wait is not None:
            raise HTTPException(
                status_code=429,
                detail=f"Trop de tentatives. Réessayez dans {wait} s.",
            )

        digest = self.users.get(username)

        if digest is None:
            # Vérification factice : même coût de calcul que pour un compte réel,
            # pour que le temps de réponse ne révèle pas l'existence du compte.
            verify_password(password, _DUMMY_HASH)
            self._failures.setdefault(username, []).append(time.time())
            return False

        if verify_password(password, digest):
            self._failures.pop(username, None)
            return True

        self._failures.setdefault(username, []).append(time.time())
        return False

    # ----------------------------------------------------------------- session

    def issue(self, response: Response, username: str) -> None:
        token = self.serializer.dumps({"u": username, "n": secrets.token_hex(8)})
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=session_max_age(),
            httponly=True,
            samesite="lax",
            # Pas de `secure=True` : le dashboard est servi en HTTP sur le LAN.
            # À passer à True le jour où un reverse proxy TLS est devant.
            secure=bool(settings.get("security.cookieSecure")),
            path="/",
        )

    def clear(self, response: Response) -> None:
        response.delete_cookie(COOKIE_NAME, path="/")

    def read(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        try:
            data = self.serializer.loads(token, max_age=session_max_age())
        except SignatureExpired:
            return None
        except BadSignature:
            log.warning("cookie de session invalide rejeté")
            return None
        user = data.get("u")
        return user if user in self.users else None


    # -------------------------------------------------------- mot de passe

    def set_password(self, username: str, password: str) -> None:
        """Enregistre une nouvelle empreinte et l'applique immédiatement."""
        users = dict(self.users)
        users[username] = hash_password(password)
        settings.set_raw("security.users", users)
        self.users = users
        # Le sel de signature change, donc toutes les autres sessions tombent —
        # comportement attendu après un changement de mot de passe. L'époque est
        # enregistrée : sans cela, un redémarrage ramènerait l'ancien sel et
        # revaliderait les cookies qu'on vient d'invalider.
        settings.set_raw("security.sessionEpoch", int(time.time()))
        self.serializer = URLSafeTimedSerializer(_load_secret(), salt=_session_salt())
        log.info("mot de passe de %s modifié", username)

    def reload_users(self) -> None:
        self.users = _load_users()


_auth: Optional[Auth] = None


def get_auth() -> Auth:
    global _auth
    if _auth is None:
        _auth = Auth()
    return _auth


# -------------------------------------------------------------- dépendances FastAPI


async def require_user(wopr_session: Optional[str] = Cookie(default=None)) -> str:
    """Dépendance posée sur toutes les routes /api sauf le login."""
    user = get_auth().read(wopr_session)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentification requise")
    return user


async def require_user_ws(websocket: WebSocket) -> Optional[str]:
    """Même contrôle pour le handshake WebSocket.

    Renvoie None si non authentifié ; l'appelant referme la socket.
    """
    return get_auth().read(websocket.cookies.get(COOKIE_NAME))
