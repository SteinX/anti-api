#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="anti-api-test"
CONTAINER_NAME="anti-api-test"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.1.38}"
HOST_PORT="${1:-8964}"
OAUTH_PORT="${2:-51121}"
CODEX_OAUTH_PORT_RANGE="${3:-1455-1465}"

echo "==> Building image: ${IMAGE_NAME} (BUN_IMAGE=${BUN_IMAGE})"
docker build --build-arg "BUN_IMAGE=${BUN_IMAGE}" -t "${IMAGE_NAME}" .

echo "==> Stopping old container (if any)"
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

echo "==> Starting container: ${CONTAINER_NAME}"
if [[ -n "${CODEX_OAUTH_REDIRECT_URL:-}" ]]; then
    docker run --rm -d \
        --name "${CONTAINER_NAME}" \
        -p "${HOST_PORT}:8964" \
        -p "${OAUTH_PORT}:51121" \
        -p "${CODEX_OAUTH_PORT_RANGE}:${CODEX_OAUTH_PORT_RANGE}" \
        -e ANTI_API_DATA_DIR=/app/data \
        -e ANTI_API_NO_OPEN=1 \
        -e ANTI_API_OAUTH_NO_OPEN=1 \
        -e "CODEX_OAUTH_REDIRECT_URL=${CODEX_OAUTH_REDIRECT_URL}" \
        -v "${HOME}/.anti-api:/app/data" \
        "${IMAGE_NAME}"
else
    docker run --rm -d \
        --name "${CONTAINER_NAME}" \
        -p "${HOST_PORT}:8964" \
        -p "${OAUTH_PORT}:51121" \
        -p "${CODEX_OAUTH_PORT_RANGE}:${CODEX_OAUTH_PORT_RANGE}" \
        -e ANTI_API_DATA_DIR=/app/data \
        -e ANTI_API_NO_OPEN=1 \
        -e ANTI_API_OAUTH_NO_OPEN=1 \
        -v "${HOME}/.anti-api:/app/data" \
        "${IMAGE_NAME}"
fi

echo "==> Tailing logs (Ctrl-C to detach, container keeps running)"
echo "    Dashboard: http://localhost:${HOST_PORT}/quota"
echo "    Antigravity OAuth callback: http://localhost:${OAUTH_PORT}/oauth-callback"
echo "    Codex OAuth callback range: ${CODEX_OAUTH_PORT_RANGE}"
if [[ -n "${CODEX_OAUTH_REDIRECT_URL:-}" ]]; then
    echo "    Codex redirect override: ${CODEX_OAUTH_REDIRECT_URL}"
fi
echo "    Stop:      docker rm -f ${CONTAINER_NAME}"
docker logs -f "${CONTAINER_NAME}"
