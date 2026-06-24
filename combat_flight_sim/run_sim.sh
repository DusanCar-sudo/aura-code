#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
exec "$DIR/venv/bin/python" "$DIR/src/main.py" "$@"
