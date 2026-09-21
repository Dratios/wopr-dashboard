#!/usr/bin/env python3
"""Génère les identifiants du dashboard WOPR.

    ./scripts/wopr-passwd.py admin             # le compte administrateur
    ./scripts/wopr-passwd.py --secret          # juste un secret de session
    ./scripts/wopr-passwd.py --secret admin    # les deux

Le mot de passe est demandé sans écho ; il n'apparaît ni à l'écran, ni dans
l'historique du shell. La sortie est à coller dans le `.env` du stack, qui ne doit
jamais être versionné (règle §7 de wopr-server-rules.md).
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import secrets
import sys

# scrypt vient de hashlib : aucune dépendance à installer, le script tourne avec
# n'importe quel Python 3.
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_LEN = 2 ** 14, 8, 1, 32
DEFAULT_USER = "admin"
MIN_LENGTH = 8


def hash_password(password: str) -> str:
    """Doit rester identique à `hash_password` de server/auth.py."""
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN,
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N, SCRYPT_R, SCRYPT_P,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def hash_for(username: str) -> str:
    while True:
        first = getpass.getpass(f"Mot de passe pour « {username} » : ")
        if len(first) < MIN_LENGTH:
            print(f"  ✗ trop court ({MIN_LENGTH} caractères minimum)", file=sys.stderr)
            continue
        second = getpass.getpass("Confirmation : ")
        if first != second:
            print("  ✗ les deux saisies diffèrent", file=sys.stderr)
            continue
        return hash_password(first)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    want_secret = "--secret" in sys.argv or not args

    if want_secret:
        print("# Secret de session — change-le et toutes les sessions sont fermées.")
        print(f"WOPR_SESSION_SECRET={secrets.token_urlsafe(48)}")
        if not args:
            return 0
        print()

    entries = [f"{user}:{hash_for(user)}" for user in args]
    print()
    print("# À reporter dans le .env de la stack (droits 0600) :")
    # Apostrophes obligatoires : sans elles, docker compose prend les `$` de
    # l'empreinte pour des variables et transmet une empreinte tronquée.
    print(f"WOPR_USERS='{','.join(entries)}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
