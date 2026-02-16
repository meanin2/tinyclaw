#!/usr/bin/env bash
# Control script for TinyClaw upstream sync

set -euo pipefail

REPO_DIR="/home/ubuntu/corefind/tinyclaw-fork"

show_help() {
    cat << EOF
TinyClaw Upstream Sync Control

USAGE:
    $0 <command>

COMMANDS:
    check       Check upstream status (same as check-upstream.sh)
    sync        Run sync now
    status      Show systemd timer status
    enable      Enable automatic sync (every 6 hours)
    disable     Disable automatic sync
    logs        Show recent sync logs
    journal     Show systemd journal
    reset       Reset sync state (next sync will be "initial")
    test        Dry-run test (fetch only, no merge)

EXAMPLES:
    $0 check                # See what's new upstream
    $0 sync                 # Sync now
    $0 enable               # Turn on auto-sync timer
    $0 logs                 # View recent activity
EOF
}

check_status() {
    cd "$REPO_DIR"
    ./scripts/check-upstream.sh
}

run_sync() {
    cd "$REPO_DIR"
    echo "Running sync..."
    ./scripts/upstream-sync.sh
}

show_systemd_status() {
    echo "=== Timer Status ==="
    sudo systemctl status tinyclaw-upstream-sync.timer --no-pager || true
    echo ""
    echo "=== Next Run ==="
    sudo systemctl list-timers tinyclaw-upstream-sync.timer --no-pager || true
}

enable_sync() {
    echo "Enabling automatic sync (every 6 hours)..."
    sudo systemctl daemon-reload
    sudo systemctl enable --now tinyclaw-upstream-sync.timer
    echo "✓ Enabled"
    echo ""
    show_systemd_status
}

disable_sync() {
    echo "Disabling automatic sync..."
    sudo systemctl disable --now tinyclaw-upstream-sync.timer
    echo "✓ Disabled"
}

show_logs() {
    LOG_FILE="$REPO_DIR/scripts/sync.log"
    if [[ -f "$LOG_FILE" ]]; then
        echo "=== Last 50 lines of sync.log ==="
        tail -50 "$LOG_FILE"
    else
        echo "No sync.log found yet"
    fi
}

show_journal() {
    echo "=== Systemd Journal (last 100 entries) ==="
    sudo journalctl -u tinyclaw-upstream-sync.service -n 100 --no-pager
}

reset_state() {
    SYNC_HASH_FILE="$REPO_DIR/scripts/.last-sync-hash"

    if [[ -f "$SYNC_HASH_FILE" ]]; then
        echo "Current sync hash: $(cat "$SYNC_HASH_FILE")"
        echo ""
        read -p "Reset sync state? This will make next sync treat all upstream commits as new [y/N]: " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cp "$SYNC_HASH_FILE" "${SYNC_HASH_FILE}.backup"
            rm "$SYNC_HASH_FILE"
            echo "✓ Sync state reset"
            echo "Backup saved to: ${SYNC_HASH_FILE}.backup"
        else
            echo "Cancelled"
        fi
    else
        echo "No sync state found (already reset)"
    fi
}

test_sync() {
    cd "$REPO_DIR"
    echo "=== Dry-run Test ==="
    echo "This will fetch upstream but not merge anything"
    echo ""

    git fetch upstream
    UPSTREAM_HEAD=$(git rev-parse upstream/main)
    OUR_HEAD=$(git rev-parse corefind/baileys-whatsapp)

    echo "Upstream HEAD: $UPSTREAM_HEAD"
    echo "Our HEAD:      $OUR_HEAD"
    echo ""

    # Try to detect potential conflicts
    echo "Checking for potential conflicts..."
    git merge-tree $(git merge-base corefind/baileys-whatsapp upstream/main) corefind/baileys-whatsapp upstream/main > /tmp/merge-preview.txt

    if grep -q "<<<<<<< " /tmp/merge-preview.txt; then
        echo "⚠ Potential conflicts detected:"
        grep -B 2 "<<<<<<< " /tmp/merge-preview.txt | head -20
    else
        echo "✓ No obvious conflicts detected"
    fi

    echo ""
    echo "Files that would be changed:"
    git diff --name-only corefind/baileys-whatsapp upstream/main | head -20
}

# Main command dispatch
case "${1:-}" in
    check)
        check_status
        ;;
    sync)
        run_sync
        ;;
    status)
        show_systemd_status
        ;;
    enable)
        enable_sync
        ;;
    disable)
        disable_sync
        ;;
    logs)
        show_logs
        ;;
    journal)
        show_journal
        ;;
    reset)
        reset_state
        ;;
    test)
        test_sync
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo "Error: Unknown command '${1:-}'"
        echo ""
        show_help
        exit 1
        ;;
esac
