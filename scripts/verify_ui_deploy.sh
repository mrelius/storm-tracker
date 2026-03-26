#!/usr/bin/env bash
# Storm Tracker — Post-Deploy UI Verification Gate
# Fetches served HTML and asserts build identity matches expected.
# Exit non-zero on ANY mismatch. This is the final gate.
set -euo pipefail

WORKTREE_PATH="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_FILE="${WORKTREE_PATH}/.build-info.json"
TARGET_HOST="${1:-10.206.8.119}"
APP_URL="http://${TARGET_HOST}:8119"

if [ ! -f "${BUILD_FILE}" ]; then
    echo "[verify] FAIL: .build-info.json not found"
    exit 1
fi

EXPECTED_BUILD=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_number'])")
EXPECTED_VERSION=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_version'])")
EXPECTED_MARKER=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_marker'])")

echo "[verify] Expected: build=${EXPECTED_BUILD} version=${EXPECTED_VERSION} marker=${EXPECTED_MARKER}"
echo "[verify] Fetching ${APP_URL}..."

HTML=$(curl -fsS "${APP_URL}" 2>&1)
FAILURES=0

# Check 1: build-version in HTML
if echo "${HTML}" | grep -q "build-version.*${EXPECTED_VERSION}"; then
    echo "[verify] PASS: build-version contains ${EXPECTED_VERSION}"
else
    echo "[verify] FAIL: build-version does NOT contain ${EXPECTED_VERSION}"
    ACTUAL=$(echo "${HTML}" | grep -o 'build-version">[^<]*' | head -1 || echo "not found")
    echo "  Actual: ${ACTUAL}"
    FAILURES=$((FAILURES + 1))
fi

# Check 2: BUILD_MARKER in HTML
if echo "${HTML}" | grep -q "BUILD_MARKER:${EXPECTED_MARKER}"; then
    echo "[verify] PASS: BUILD_MARKER matches"
else
    echo "[verify] FAIL: BUILD_MARKER does NOT match"
    FAILURES=$((FAILURES + 1))
fi

# Check 3: __ST_BUILD__ matches
if echo "${HTML}" | grep -q "__ST_BUILD__ = ${EXPECTED_BUILD}"; then
    echo "[verify] PASS: __ST_BUILD__ = ${EXPECTED_BUILD}"
else
    echo "[verify] FAIL: __ST_BUILD__ does NOT match ${EXPECTED_BUILD}"
    ACTUAL=$(echo "${HTML}" | grep -o '__ST_BUILD__ = [0-9]*' | head -1 || echo "not found")
    echo "  Actual: ${ACTUAL}"
    FAILURES=$((FAILURES + 1))
fi

# Check 4: All script/css ?v= tags match expected build
EXPECTED_TAG="?v=${EXPECTED_BUILD}"
MATCHING_TAGS=$(echo "${HTML}" | grep -c "${EXPECTED_TAG}" || true)
TOTAL_VTAGS=$(echo "${HTML}" | grep -co '?v=[0-9]*' || true)

if [ "${MATCHING_TAGS}" -eq "${TOTAL_VTAGS}" ] && [ "${TOTAL_VTAGS}" -gt 0 ]; then
    echo "[verify] PASS: All ${TOTAL_VTAGS} asset tags use ${EXPECTED_TAG}"
else
    echo "[verify] FAIL: ${MATCHING_TAGS}/${TOTAL_VTAGS} asset tags match ${EXPECTED_TAG}"
    STALE=$(echo "${HTML}" | grep -oP '\?v=\d+' | sort | uniq -c | sort -rn | head -5)
    echo "  Tag distribution: ${STALE}"
    FAILURES=$((FAILURES + 1))
fi

# Check 5: No stale prior-version tags
PREV_BUILD=$((EXPECTED_BUILD - 1))
STALE_COUNT=$(echo "${HTML}" | grep -c "?v=${PREV_BUILD}" || true)
if [ "${STALE_COUNT}" -eq 0 ]; then
    echo "[verify] PASS: No stale ?v=${PREV_BUILD} tags"
else
    echo "[verify] FAIL: Found ${STALE_COUNT} stale ?v=${PREV_BUILD} tags"
    FAILURES=$((FAILURES + 1))
fi

# Check 6: Key new scripts present
for SCRIPT in "audio-demo-scenarios.js" "audio-demo-controller.js" "context-zoom-resolver.js"; do
    if echo "${HTML}" | grep -q "${SCRIPT}"; then
        echo "[verify] PASS: ${SCRIPT} included"
    else
        echo "[verify] FAIL: ${SCRIPT} NOT included in served HTML"
        FAILURES=$((FAILURES + 1))
    fi
done

# Final gate
echo ""
if [ "${FAILURES}" -eq 0 ]; then
    echo "[verify] ══ ALL CHECKS PASSED ══"
    exit 0
else
    echo "[verify] ══ DEPLOY VERIFICATION FAILED — ${FAILURES} check(s) failed ══"
    echo "[verify] UI change NOT complete — deployment verification failed."
    exit 1
fi
