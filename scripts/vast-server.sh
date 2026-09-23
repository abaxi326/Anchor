#!/usr/bin/env bash
# Bootstrap the model server inside an existing Vast Linux instance.
set -euo pipefail
anchor_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${OPEN_ANCHOR_PYTHON:-}" ]]; then
  anchor_python="$OPEN_ANCHOR_PYTHON"
elif command -v python3.12 >/dev/null 2>&1; then
  anchor_python=python3.12
else
  anchor_python=python3
fi
"$anchor_python" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 15) else "Open Anchor needs Python 3.10–3.14; set OPEN_ANCHOR_PYTHON to a supported interpreter.")'
exec "$anchor_python" "$anchor_script_dir/vast_server.py" "$@"
