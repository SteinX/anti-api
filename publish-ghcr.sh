#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    cat <<'EOF'
Usage: ./publish-ghcr.sh <github-owner> [image-name] [tag]

Examples:
  ./publish-ghcr.sh myuser
  ./publish-ghcr.sh myorg anti-api v2.6.0

Environment variables:
  LOCAL_IMAGE   Local image name to tag (default: anti-api)
  BUN_IMAGE     Docker build arg for base image (default: oven/bun:1.1.38)
  SKIP_BUILD    Set to 1 to skip local build and only tag+push
  PUSH_LATEST   Set to 0 to skip pushing :latest (default: 1)
EOF
    exit 0
fi

NAMESPACE="${1:-}"
IMAGE_NAME="${2:-anti-api}"
INPUT_TAG="${3:-}"

if [[ -z "${NAMESPACE}" ]]; then
    echo "Error: missing GitHub owner/namespace." >&2
    echo "Run ./publish-ghcr.sh --help for usage." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker command not found." >&2
    exit 1
fi

LOCAL_IMAGE="${LOCAL_IMAGE:-anti-api}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.1.38}"
PUSH_LATEST="${PUSH_LATEST:-1}"

if [[ -n "${INPUT_TAG}" ]]; then
    VERSION_TAG="${INPUT_TAG}"
else
    if ! command -v bun >/dev/null 2>&1; then
        echo "Error: bun command not found, please pass a tag manually." >&2
        exit 1
    fi
    VERSION_TAG="$(bun -e 'const pkg = await Bun.file("package.json").json(); console.log(`v${pkg.version}`);')"
fi

TARGET_REPO="ghcr.io/${NAMESPACE}/${IMAGE_NAME}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    echo "==> Building local image: ${LOCAL_IMAGE}"
    docker build --build-arg "BUN_IMAGE=${BUN_IMAGE}" -t "${LOCAL_IMAGE}" .
fi

echo "==> Verifying Docker login"
if ! docker info >/dev/null 2>&1; then
    echo "Error: docker daemon is unavailable." >&2
    exit 1
fi

echo "==> Ensure you are logged in to GHCR"
echo "    Example: echo \"<GH_TOKEN>\" | docker login ghcr.io -u <github-username> --password-stdin"

echo "==> Tagging image"
docker tag "${LOCAL_IMAGE}" "${TARGET_REPO}:${VERSION_TAG}"

echo "==> Pushing ${TARGET_REPO}:${VERSION_TAG}"
docker push "${TARGET_REPO}:${VERSION_TAG}"

if [[ "${PUSH_LATEST}" == "1" ]]; then
    docker tag "${LOCAL_IMAGE}" "${TARGET_REPO}:latest"
    echo "==> Pushing ${TARGET_REPO}:latest"
    docker push "${TARGET_REPO}:latest"
fi

echo "==> Done"
echo "Published tags:"
echo "  - ${TARGET_REPO}:${VERSION_TAG}"
if [[ "${PUSH_LATEST}" == "1" ]]; then
    echo "  - ${TARGET_REPO}:latest"
fi
