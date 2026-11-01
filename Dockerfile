FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MCP_TRANSPORT=http \
    MCP_PORT=8080 \
    MEMORY_VAULT_PATH=/data/vault \
    MEMORY_INDEX_PATH=/data/index.db

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
RUN useradd --create-home app && mkdir -p /data && chown app /data
USER app

VOLUME ["/data"]
EXPOSE 8080
CMD ["python", "server.py"]
