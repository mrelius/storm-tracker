#!/usr/bin/env bash
# Storm Tracker — UI Change Detector
# Checks if recent changes affect the frontend.
# Exit 0 = UI changes detected (deploy required)
# Exit 1 = No UI changes (deploy not required)
set -euo pipefail

COMPARE="${1:-HEAD~1..HEAD}"

UI_PATTERNS="^templates/|^static/js/|^static/css/|^static/sw\.js|^\.build-info\.json|^config\.py"

CHANGES=$(git diff --name-only ${COMPARE} 2>/dev/null || git diff --name-only HEAD 2>/dev/null || echo "")

if [ -z "${CHANGES}" ]; then
    # No git diff available, check working tree
    CHANGES=$(git status --porcelain | awk '{print $2}')
fi

UI_FILES=$(echo "${CHANGES}" | grep -E "${UI_PATTERNS}" || true)

if [ -n "${UI_FILES}" ]; then
    echo "[ui-detect] UI-affecting changes detected:"
    echo "${UI_FILES}" | sed 's/^/  /'
    echo ""
    echo "[ui-detect] DEPLOY REQUIRED — run: scripts/deploy_ui.sh"
    exit 0
else
    echo "[ui-detect] No UI-affecting changes."
    exit 1
fi
