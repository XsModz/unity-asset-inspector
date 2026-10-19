#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd -- "${APP_DIR}/../.." && pwd)"

exec "${WORKSPACE_DIR}/.pythonlibs/bin/gunicorn" \
  --chdir "${APP_DIR}" \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers 1 \
  --threads 1 \
  --timeout 600 \
  --access-logfile - \
  backend.app:app