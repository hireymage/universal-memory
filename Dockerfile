# Universal Memory MCP – container image
# Build:  docker build -t universal-memory-mcp:local .
# Tests:  docker build --target test .
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM build AS test
COPY vitest.config.ts ./
COPY tests ./tests
RUN npm test

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MEMORY_CONFIG=/config/config.yml \
    TORCH_HOME=/tmp/torch \
    XDG_CACHE_HOME=/tmp
WORKDIR /app
# Experimental BDH sidecar (CPU PyTorch) lives in a venv next to the Node runtime.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && python3 -m venv /opt/neural \
 && /opt/neural/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple torch \
 && apt-get purge -y python3-venv && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Vector layer: sentence-transformers plus the multilingual e5-small weights, baked in at build time
# so the running container needs no network (HF_HUB_OFFLINE=1).
ARG EMBED_MODEL=intfloat/multilingual-e5-base
RUN /opt/neural/bin/pip install --no-cache-dir --extra-index-url https://pypi.org/simple sentence-transformers \
 && mkdir -p /opt/models \
 && SENTENCE_TRANSFORMERS_HOME=/opt/models /opt/neural/bin/python -c "import os; from sentence_transformers import SentenceTransformer; SentenceTransformer(os.environ.get('EMBED_MODEL','${EMBED_MODEL}'), cache_folder='/opt/models')" \
 && rm -rf /root/.cache/pip
ENV SENTENCE_TRANSFORMERS_HOME=/opt/models HF_HUB_OFFLINE=1
RUN groupadd --system --gid 10001 memory \
 && useradd --system --uid 10001 --gid memory --home-dir /app --shell /usr/sbin/nologin memory \
 && mkdir -p /vault /state /state/neural /config /tmp/torch \
 && chown memory:memory /vault /state /state/neural /tmp/torch
COPY --from=prod-deps --chown=memory:memory /app/node_modules ./node_modules
COPY --from=build --chown=memory:memory /app/dist ./dist
COPY --chown=memory:memory package.json ./
COPY --chown=memory:memory neural/bdh_memory /app/neural/bdh_memory
COPY --chown=memory:memory config.docker.yml /config/config.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh
USER memory
EXPOSE 27123
VOLUME ["/vault", "/state"]
# Health port must match http.port in the mounted config (config.strata.yml uses 8080 -> UMM_HEALTH_PORT=8080).
ENV UMM_HEALTH_PORT=27123
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.UMM_HEALTH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve"]
