#!/usr/bin/env bash
# One command to set up and run Baton: ./run.sh   (REBUILD=1 ./run.sh to rebuild the web app)
set -euo pipefail
cd "$(dirname "$0")"

# Repo-local Node, if someone dropped one in .tools/
[ -d .tools/node/bin ] && export PATH="$PWD/.tools/node/bin:$PATH"

if [ ! -x .venv/bin/python ]; then
  PY=""
  for c in ${PYTHON:-} python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then PY=$c; break; fi
  done
  [ -n "$PY" ] || { echo "Baton needs Python 3.10 or newer." >&2; exit 1; }
  echo "Creating virtualenv with $PY…"
  "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

if [ ! -f web/dist/index.html ] || [ "${REBUILD:-0}" = "1" ]; then
  command -v npm >/dev/null 2>&1 || { echo "Building the web app needs Node 20.19+ (with npm)." >&2; exit 1; }
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' \
    || { echo "Node $(node --version) is too old to build the web app; install Node 20.19+ or 22.12+." >&2; exit 1; }
  echo "Building the web app…"
  (cd web && npm install --silent && npm run build --silent)
fi

PYTHONPATH=backend exec .venv/bin/python -m baton
