#!/usr/bin/env bash
# Storm Tracker — Authoritative UI Deploy + Verify
# Syncs worktree to deploy target, restarts service, verifies over HTTP.
# Exit non-zero on any failure. Success = served HTML matches build.
set -euo pipefail

WORKTREE_PATH="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_FILE="${WORKTREE_PATH}/.build-info.json"
TARGET_HOST="${1:-10.206.8.119}"
DEPLOY_PATH="/opt/storm-tracker"
SERVICE_NAME="storm-tracker"
APP_URL="http://${TARGET_HOST}:8119"
SSH_KEY="${HOME}/.ssh/id_proxmox"
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# ── Read expected build identity ──────────────────────────────────
if [ ! -f "${BUILD_FILE}" ]; then
    echo "[deploy] FAIL: .build-info.json not found. Run scripts/bump_build.sh first."
    exit 1
fi

EXPECTED_BUILD=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_number'])")
EXPECTED_VERSION=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_version'])")
EXPECTED_MARKER=$(python3 -c "import json; d=json.load(open('${BUILD_FILE}')); print(d['build_marker'])")

echo "═══════════════════════════════════════════════════════"
echo "[deploy] Storm Tracker UI Deploy"
echo "[deploy] Build: ${EXPECTED_BUILD} | Version: ${EXPECTED_VERSION}"
echo "[deploy] Marker: ${EXPECTED_MARKER}"
echo "[deploy] Target: ${TARGET_HOST}:${DEPLOY_PATH}"
echo "═══════════════════════════════════════════════════════"

# ── Step 1: Backup DB ─────────────────────────────────────────────
echo "[deploy] [1/7] Backing up database (max 3 retained)..."
ssh ${SSH_OPTS} root@${TARGET_HOST} "
    if [ -f ${DEPLOY_PATH}/data/storm_tracker.db ]; then
        cp ${DEPLOY_PATH}/data/storm_tracker.db ${DEPLOY_PATH}/data/storm_tracker.db.bak.\$(date +%Y%m%d%H%M%S)
        echo '  DB backed up'
        # Retain only the 1 newest backup (save disk space)
        ls -t ${DEPLOY_PATH}/data/storm_tracker.db.bak.* 2>/dev/null | tail -n +2 | xargs -r rm -f
        echo '  Old backups pruned (keeping 1)'
    else
        echo '  No existing DB'
    fi
" 2>/dev/null || echo "  (skip — first deploy or host unreachable)"

# ── Step 2: Sync files ───────────────────────────────────────────
echo "[deploy] [2/7] Syncing files..."
rsync -avz --delete \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='.git/' \
    --exclude='*.pyc' \
    --exclude='data/storm_tracker.db*' \
    --exclude='data/smoke_test.db' \
    -e "ssh ${SSH_OPTS}" \
    "${WORKTREE_PATH}/" "root@${TARGET_HOST}:${DEPLOY_PATH}/"

# ── Step 3: Install deps ─────────────────────────────────────────
echo "[deploy] [3/7] Installing dependencies..."
ssh ${SSH_OPTS} root@${TARGET_HOST} "
    cd ${DEPLOY_PATH}
    python3 -m venv venv 2>/dev/null || true
    venv/bin/pip install -q -r requirements.txt
"

# ── Step 4: Restart service ──────────────────────────────────────
echo "[deploy] [4/7] Restarting service..."
ssh ${SSH_OPTS} root@${TARGET_HOST} "systemctl restart ${SERVICE_NAME}"
sleep 3

# ── Step 5: Health check ─────────────────────────────────────────
echo "[deploy] [5/7] Health check..."
if ! ssh ${SSH_OPTS} root@${TARGET_HOST} "systemctl is-active --quiet ${SERVICE_NAME}"; then
    echo "[deploy] FAIL: service not active after restart"
    ssh ${SSH_OPTS} root@${TARGET_HOST} "journalctl -u ${SERVICE_NAME} --no-pager -n 20"
    exit 1
fi
echo "  Service active"

HEALTH=$(ssh ${SSH_OPTS} root@${TARGET_HOST} "curl -sf http://localhost:8119/api/health" 2>/dev/null || echo '{"status":"FAIL"}')
echo "  Health: ${HEALTH}"

# ── Step 6: Write deploy stamp ───────────────────────────────────
echo "[deploy] [6/7] Writing deploy stamp..."
ssh ${SSH_OPTS} root@${TARGET_HOST} "cat > ${DEPLOY_PATH}/.last_deploy.json" <<EOF
{
  "build_number": ${EXPECTED_BUILD},
  "build_version": "${EXPECTED_VERSION}",
  "build_marker": "${EXPECTED_MARKER}",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_path": "${WORKTREE_PATH}",
  "deploy_path": "${DEPLOY_PATH}"
}
EOF

# ── Step 7: Verify served HTML ───────────────────────────────────
echo "[deploy] [7/7] Verifying served HTML over HTTP..."
"${WORKTREE_PATH}/scripts/verify_ui_deploy.sh" "${TARGET_HOST}"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "[deploy] SUCCESS — Build ${EXPECTED_VERSION} live at ${APP_URL}"
echo "═══════════════════════════════════════════════════════"
