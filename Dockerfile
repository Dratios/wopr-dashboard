# ==========================================================================
# Étape 1 — compilation du frontend React
# ==========================================================================
FROM node:22-alpine AS frontend

WORKDIR /app

# Les dépendances sont copiées seules d'abord : tant que package.json ne change
# pas, cette couche est réutilisée et `npm ci` n'est pas rejoué.
COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./
RUN npm run build


# ==========================================================================
# Étape 2 — exécution : API FastAPI + service du frontend compilé
# ==========================================================================
FROM python:3.12-slim

WORKDIR /app

# util-linux fournit `nsenter`, par lequel passent toutes les actions sur l'hôte
# (systemctl, docker compose, modprobe). iputils-ping sert aux mesures de latence.
# Les binaires système eux-mêmes ne sont PAS installés ici : `nsenter -m` exécute
# ceux de l'hôte, dans son propre espace de montage.
RUN apt-get update && apt-get install -y --no-install-recommends \
        util-linux \
        iputils-ping \
    && rm -rf /var/lib/apt/lists/*

COPY app/server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY app/server/ ./server/
COPY scripts/ ./scripts/
COPY --from=frontend /app/dist ./dist

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WOPR_IN_CONTAINER=1 \
    WOPR_CONFIG_DIR=/config \
    WOPR_DATA_DIR=/data \
    WOPR_HOST_ROOT=/host/root \
    BIND_ADDR=127.0.0.1 \
    BIND_PORT=8080

EXPOSE 8080

# Healthcheck sur la sonde publique : elle ne demande pas de session.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python3 -c "import os,urllib.request; \
        urllib.request.urlopen(f\"http://{os.environ['BIND_ADDR']}:{os.environ['BIND_PORT']}/api/status\", timeout=4)" \
        || exit 1

# `exec` pour que uvicorn devienne PID 1 et reçoive SIGTERM : c'est ce qui permet
# au `lifespan` de rendre les ventilateurs à la carte mère avant l'arrêt.
# --timeout-graceful-shutdown : sans limite, uvicorn attend indéfiniment les
# connexions ouvertes et Docker finit par envoyer SIGKILL (10 s par défaut), ce qui
# saute le `lifespan`. À 5 s, il reste le temps de rendre les ventilateurs.
CMD exec python3 -m uvicorn server.main:app \
        --host "$BIND_ADDR" --port "$BIND_PORT" \
        --proxy-headers --no-server-header \
        --timeout-graceful-shutdown 5
