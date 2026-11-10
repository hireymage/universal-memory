# Optional BDH associative-memory sidecar. CPU only.
# Build from this directory: docker build -t umm-bdh-memory neural
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BDH_BIND=0.0.0.0 \
    BDH_PORT=8091 \
    BDH_STATE_DIR=/state/neural \
    TORCH_HOME=/tmp/torch \
    XDG_CACHE_HOME=/tmp \
    HOME=/tmp

WORKDIR /app
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && groupadd --system --gid 10001 memory \
 && useradd --system --uid 10001 --gid memory --home-dir /app --shell /usr/sbin/nologin memory \
 && mkdir -p /state /tmp/torch \
 && chown memory:memory /state /tmp/torch

COPY bdh_memory ./bdh_memory
USER memory
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8091/health').read()"
CMD ["python", "-m", "bdh_memory"]
