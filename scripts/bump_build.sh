#!/usr/bin/env bash
# Storm Tracker — Build Version Bumper
# Increments build number, updates all version references.
# Usage: ./scripts/bump_build.sh [optional_build_number]
set -euo pipefail

WORKTREE_PATH="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_FILE="${WORKTREE_PATH}/.build-info.json"
INDEX_HTML="${WORKTREE_PATH}/templates/index.html"
SW_JS="${WORKTREE_PATH}/static/sw.js"

# Read current build
CURRENT_BUILD=$(python3 -c "import json; print(json.load(open('${BUILD_FILE}'))['build_number'])")

# Determine next build
if [ -n "${1:-}" ]; then
    NEXT_BUILD="$1"
else
    NEXT_BUILD=$((CURRENT_BUILD + 1))
fi

NEXT_VERSION="v${NEXT_BUILD}"
NEXT_MARKER="${NEXT_VERSION}-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[bump] ${CURRENT_BUILD} -> ${NEXT_BUILD}"

# 1. Update .build-info.json
cat > "${BUILD_FILE}" <<EOF
{
  "build_number": ${NEXT_BUILD},
  "build_version": "${NEXT_VERSION}",
  "build_marker": "${NEXT_MARKER}",
  "built_at": "${BUILT_AT}"
}
EOF
echo "[bump] Updated .build-info.json"

# 2. Update index.html — build-version span
sed -i "s|<span id=\"build-version\" class=\"build-version\">v[0-9]*</span>|<span id=\"build-version\" class=\"build-version\">${NEXT_VERSION}</span>|" "${INDEX_HTML}"

# 3. Update index.html — BUILD_MARKER comment
sed -i "s|<!-- BUILD_MARKER:[^ ]* -->|<!-- BUILD_MARKER:${NEXT_MARKER} -->|" "${INDEX_HTML}"

# 4. Update index.html — __ST_BUILD__
sed -i "s|window.__ST_BUILD__ = [0-9]*;|window.__ST_BUILD__ = ${NEXT_BUILD};|" "${INDEX_HTML}"

# 4b. Update index.html — __ST_BUILD_INFO__ block
python3 -c "
import re, sys
with open('${INDEX_HTML}', 'r') as f:
    html = f.read()
new_block = '''window.__ST_BUILD_INFO__ = {
            build_number: ${NEXT_BUILD},
            build_version: \"${NEXT_VERSION}\",
            build_marker: \"${NEXT_MARKER}\",
            built_at: \"${BUILT_AT}\"
        };'''
html = re.sub(
    r'window\.__ST_BUILD_INFO__\s*=\s*\{[^}]+\};',
    new_block,
    html
)
with open('${INDEX_HTML}', 'w') as f:
    f.write(html)
"

# 5. Update all ?v= query params in index.html
sed -i "s|?v=[0-9]*|?v=${NEXT_BUILD}|g" "${INDEX_HTML}"

# 6. Update service worker cache name
sed -i "s|storm-tracker-v[0-9]*|storm-tracker-v${NEXT_BUILD}|" "${SW_JS}"

echo "[bump] Updated index.html and sw.js"
echo "[bump] Build: ${NEXT_BUILD} | Version: ${NEXT_VERSION} | Marker: ${NEXT_MARKER}"
