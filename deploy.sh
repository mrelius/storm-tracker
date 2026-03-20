#!/bin/bash
# Storm Tracker — Deploy Script
# Usage: ./deploy.sh [target_host]
# Default target: 10.206.8.119 (LXC 119)

set -euo pipefail

TARGET="${1:-10.206.8.119}"
REMOTE_DIR="/opt/storm-tracker"
SSH_KEY="$HOME/.ssh/id_proxmox"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

echo "=== Storm Tracker Deploy to $TARGET ==="

# Backup existing DB if present
echo "[1/6] Backing up database..."
ssh $SSH_OPTS root@$TARGET "
    if [ -f $REMOTE_DIR/data/storm_tracker.db ]; then
        cp $REMOTE_DIR/data/storm_tracker.db $REMOTE_DIR/data/storm_tracker.db.bak.\$(date +%Y%m%d%H%M%S)
        echo 'DB backed up'
    else
        echo 'No existing DB'
    fi
" 2>/dev/null || echo "  (skip — host not reachable or first deploy)"

# Sync files (exclude venv, __pycache__, .git, tests, backups)
echo "[2/6] Syncing files..."
rsync -avz --delete \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='.git/' \
    --exclude='*.pyc' \
    --exclude='data/storm_tracker.db*' \
    --exclude='data/smoke_test.db' \
    -e "ssh $SSH_OPTS" \
    "$(dirname "$0")/" "root@$TARGET:$REMOTE_DIR/"

# Install/update venv
echo "[3/6] Installing dependencies..."
ssh $SSH_OPTS root@$TARGET "
    cd $REMOTE_DIR
    python3 -m venv venv 2>/dev/null || true
    venv/bin/pip install -q -r requirements.txt
"

# Install systemd service
echo "[4/6] Installing service..."
ssh $SSH_OPTS root@$TARGET "
    cp $REMOTE_DIR/storm-tracker.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable storm-tracker
"

# Restart service
echo "[5/6] Restarting service..."
ssh $SSH_OPTS root@$TARGET "systemctl restart storm-tracker"
sleep 3

# Verify
echo "[6/6] Verifying..."
HEALTH=$(ssh $SSH_OPTS root@$TARGET "curl -sf http://localhost:8119/api/health" 2>/dev/null || echo '{"status":"FAIL"}')
echo "  Health: $HEALTH"

STATUS=$(ssh $SSH_OPTS root@$TARGET "systemctl is-active storm-tracker" 2>/dev/null)
echo "  Service: $STATUS"

echo "=== Deploy complete ==="
echo "  URL: http://$TARGET:8119"
