#!/usr/bin/env bash
# Quick utility to check upstream status without syncing

set -euo pipefail

REPO_DIR="/home/ubuntu/corefind/tinyclaw-fork"
SYNC_HASH_FILE="$REPO_DIR/scripts/.last-sync-hash"

cd "$REPO_DIR"

echo "=== TinyClaw Upstream Status ==="
echo ""

# Fetch upstream
echo "Fetching upstream..."
git fetch upstream --quiet

# Get hashes
LAST_SYNC=$(cat "$SYNC_HASH_FILE" 2>/dev/null || echo "never")
UPSTREAM_HEAD=$(git rev-parse upstream/main)
OUR_HEAD=$(git rev-parse corefind/baileys-whatsapp)

echo "Our branch:        corefind/baileys-whatsapp"
echo "Our HEAD:          $OUR_HEAD"
echo ""
echo "Upstream branch:   upstream/main"
echo "Upstream HEAD:     $UPSTREAM_HEAD"
echo ""
echo "Last synced hash:  $LAST_SYNC"
echo ""

# Check if sync needed
if [[ "$LAST_SYNC" == "$UPSTREAM_HEAD" ]]; then
    echo "✓ Already up to date with upstream"
    exit 0
fi

# Show what's new
if [[ "$LAST_SYNC" == "never" ]]; then
    echo "⚠ No previous sync found"
    echo ""
    echo "Recent upstream commits (last 10):"
    git log --oneline upstream/main -10
else
    COMMIT_COUNT=$(git rev-list --count "$LAST_SYNC..$UPSTREAM_HEAD" 2>/dev/null || echo "unknown")
    echo "⚠ Upstream has $COMMIT_COUNT new commit(s)"
    echo ""
    echo "New commits:"
    git log --oneline "$LAST_SYNC..$UPSTREAM_HEAD" 2>/dev/null || git log --oneline upstream/main -10
fi

echo ""
echo "---"
echo "To sync now, run: ./scripts/upstream-sync.sh"
