#!/usr/bin/env bash
# Pre-flight check for upstream sync system

set -euo pipefail

echo "=== TinyClaw Upstream Sync - Pre-flight Check ==="
echo ""

ERRORS=0
WARNINGS=0

# Check function
check() {
    local name="$1"
    local command="$2"
    local required="${3:-yes}"

    printf "%-30s " "$name"
    set +e
    eval "$command" &>/dev/null
    local result=$?
    set -e

    if [[ $result -eq 0 ]]; then
        echo "✓"
        return 0
    else
        if [[ "$required" == "yes" ]]; then
            echo "✗ MISSING (required)"
            ERRORS=$((ERRORS + 1))
        else
            echo "⚠ MISSING (optional)"
            WARNINGS=$((WARNINGS + 1))
        fi
        return 0
    fi
}

# Core dependencies
echo "Core Dependencies:"
check "Git" "command -v git"
check "Node.js" "command -v node"
check "npm" "command -v npm"
check "jq" "command -v jq"
check "Claude Code CLI" "command -v claude"
echo ""

# Optional dependencies
echo "Optional Dependencies:"
check "openclaw (for WhatsApp)" "command -v openclaw" "no"
echo ""

# Repository setup
echo "Repository Configuration:"
check "Fork remote (origin)" "git remote get-url origin | grep -q meanin2/tinyclaw"
check "Upstream remote" "git remote get-url upstream | grep -q jlia0/tinyclaw"
check "On correct branch" "git rev-parse --abbrev-ref HEAD | grep -q corefind/baileys-whatsapp"
echo ""

# File checks
echo "Script Files:"
check "upstream-sync.sh" "test -x /home/ubuntu/corefind/tinyclaw-fork/scripts/upstream-sync.sh"
check "check-upstream.sh" "test -x /home/ubuntu/corefind/tinyclaw-fork/scripts/check-upstream.sh"
check "sync-control.sh" "test -x /home/ubuntu/corefind/tinyclaw-fork/scripts/sync-control.sh"
echo ""

# Systemd checks
echo "Systemd Configuration:"
check "Service file" "test -f /etc/systemd/system/tinyclaw-upstream-sync.service"
check "Timer file" "test -f /etc/systemd/system/tinyclaw-upstream-sync.timer"
set +e
TIMER_ENABLED=$(sudo systemctl is-enabled tinyclaw-upstream-sync.timer 2>/dev/null)
set -e
if [[ "$TIMER_ENABLED" == "enabled" ]]; then
    echo "Timer status                   ✓ enabled"
else
    echo "Timer status                   ⚠ disabled (run: ./scripts/sync-control.sh enable)"
    WARNINGS=$((WARNINGS + 1))
fi
echo ""

# Our modifications check
echo "Protected Files:"
set +e
grep -q "baileys" /home/ubuntu/corefind/tinyclaw-fork/package.json
if [[ $? -eq 0 ]]; then
    echo "package.json (baileys)         ✓"
else
    echo "package.json (baileys)         ✗ MISSING"
    ERRORS=$((ERRORS + 1))
fi

grep -q "Baileys" /home/ubuntu/corefind/tinyclaw-fork/src/channels/whatsapp-client.ts
if [[ $? -eq 0 ]]; then
    echo "whatsapp-client.ts (Baileys)   ✓"
else
    echo "whatsapp-client.ts (Baileys)   ✗ WRONG VERSION"
    ERRORS=$((ERRORS + 1))
fi
set -e
echo ""

# Summary
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]] && [[ $WARNINGS -eq 0 ]]; then
    echo "✓ All checks passed - ready to sync"
    exit 0
elif [[ $ERRORS -eq 0 ]]; then
    echo "⚠ $WARNINGS warning(s) - sync will work but some features may be limited"
    exit 0
else
    echo "✗ $ERRORS error(s), $WARNINGS warning(s) - fix errors before syncing"
    exit 1
fi
