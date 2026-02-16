#!/usr/bin/env bash
# TinyClaw Upstream Sync Script
# Automatically syncs changes from upstream (jlia0/tinyclaw) to our fork (meanin2/tinyclaw)
# while preserving our Baileys WhatsApp implementation.

set -euo pipefail

# Configuration
REPO_DIR="/home/ubuntu/corefind/tinyclaw-fork"
LOG_FILE="$REPO_DIR/scripts/sync.log"
SYNC_HASH_FILE="$REPO_DIR/scripts/.last-sync-hash"
CONFLICT_FILE="$REPO_DIR/scripts/conflicts.txt"
OUR_BRANCH="corefind/baileys-whatsapp"
UPSTREAM_BRANCH="upstream/main"
TEMP_MERGE_BRANCH="temp-upstream-sync-$(date +%s)"

# WhatsApp notification recipient
WHATSAPP_TARGET="972548790112@s.whatsapp.net"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Error handler
error() {
    log "ERROR: $*"
    send_notification "TinyClaw upstream sync failed: $*"
    exit 1
}

# Send WhatsApp notification
send_notification() {
    local message="$1"
    if command -v openclaw &> /dev/null; then
        openclaw message send --channel whatsapp --target "$WHATSAPP_TARGET" --message "$message" 2>&1 | tee -a "$LOG_FILE" || true
    else
        log "WARNING: openclaw not available, skipping notification: $message"
    fi
}

# Check if Claude Code CLI is available
check_claude() {
    if ! command -v claude &> /dev/null; then
        error "Claude Code CLI not found - cannot resolve conflicts automatically"
    fi
}

# Clean up temporary branches
cleanup() {
    log "Cleaning up..."
    cd "$REPO_DIR"
    git checkout "$OUR_BRANCH" 2>/dev/null || true
    git branch -D "$TEMP_MERGE_BRANCH" 2>/dev/null || true
    rm -f "$CONFLICT_FILE"
}

# Analyze and resolve conflicts using Claude
resolve_conflicts_with_claude() {
    log "Attempting to resolve conflicts with Claude Code CLI..."

    # Get list of conflicted files
    local conflicted_files
    conflicted_files=$(git diff --name-only --diff-filter=U)

    if [[ -z "$conflicted_files" ]]; then
        log "No conflicted files found"
        return 0
    fi

    log "Conflicted files:"
    echo "$conflicted_files" | tee -a "$LOG_FILE"

    # Save conflict details
    {
        echo "=== UPSTREAM SYNC CONFLICTS ==="
        echo "Date: $(date)"
        echo "Branch: $OUR_BRANCH"
        echo "Upstream: $UPSTREAM_BRANCH"
        echo ""
        echo "Conflicted files:"
        echo "$conflicted_files"
        echo ""
        echo "=== CONFLICT DETAILS ==="
    } > "$CONFLICT_FILE"

    # Check if whatsapp-client.ts is conflicted
    if echo "$conflicted_files" | grep -q "whatsapp-client.ts"; then
        log "WARNING: whatsapp-client.ts has conflicts - keeping our Baileys version"
        # Always keep our version for whatsapp-client.ts
        git checkout --ours src/channels/whatsapp-client.ts
        git add src/channels/whatsapp-client.ts
        echo "RESOLVED: whatsapp-client.ts (kept our Baileys implementation)" >> "$CONFLICT_FILE"
    fi

    # Check if package.json is conflicted
    if echo "$conflicted_files" | grep -q "package.json"; then
        log "WARNING: package.json has conflicts - attempting smart merge"

        # Create a Claude prompt for smart package.json merge
        local claude_prompt="Resolve the package.json merge conflict intelligently:

1. PRESERVE these dependencies (our Baileys implementation):
   - baileys
   - @hapi/boom
   - pino

2. REMOVE this dependency if present (we replaced it):
   - whatsapp-web.js

3. MERGE any new dependencies from upstream that don't conflict

4. Keep all other changes from upstream (scripts, metadata, etc.)

Current conflict in package.json:
$(cat package.json)

Output the fully resolved package.json file."

        # Use Claude to resolve package.json
        if echo "$claude_prompt" | claude -m opus --no-stream > /tmp/resolved-package.json 2>/dev/null; then
            # Extract JSON from Claude's response (may have markdown fences)
            if grep -q "^{" /tmp/resolved-package.json; then
                # Validate JSON
                if jq empty /tmp/resolved-package.json 2>/dev/null; then
                    cp /tmp/resolved-package.json package.json
                    git add package.json
                    echo "RESOLVED: package.json (Claude smart merge)" >> "$CONFLICT_FILE"
                    log "Successfully resolved package.json with Claude"
                else
                    log "ERROR: Claude output is not valid JSON"
                    return 1
                fi
            else
                log "ERROR: Could not extract JSON from Claude response"
                return 1
            fi
        else
            log "ERROR: Claude failed to resolve package.json"
            return 1
        fi
    fi

    # Check if there are still unresolved conflicts
    conflicted_files=$(git diff --name-only --diff-filter=U)

    if [[ -n "$conflicted_files" ]]; then
        log "ERROR: Still have unresolved conflicts in: $conflicted_files"
        echo "UNRESOLVED: $conflicted_files" >> "$CONFLICT_FILE"

        # Create detailed conflict report for remaining files
        for file in $conflicted_files; do
            echo "" >> "$CONFLICT_FILE"
            echo "=== $file ===" >> "$CONFLICT_FILE"
            git diff "$file" >> "$CONFLICT_FILE" || true
        done

        send_notification "TinyClaw upstream sync: manual intervention needed - unresolved conflicts in: $conflicted_files"
        return 1
    fi

    log "All conflicts resolved successfully"
    return 0
}

# Main sync logic
main() {
    log "=== Starting TinyClaw Upstream Sync ==="

    # Ensure we're in the repo directory
    cd "$REPO_DIR" || error "Cannot cd to $REPO_DIR"

    # Check Claude availability
    check_claude

    # Fetch upstream changes
    log "Fetching upstream changes..."
    git fetch upstream || error "Failed to fetch upstream"

    # Get last synced hash
    local last_hash=""
    if [[ -f "$SYNC_HASH_FILE" ]]; then
        last_hash=$(cat "$SYNC_HASH_FILE")
        log "Last synced hash: $last_hash"
    else
        log "No previous sync found - this is the first sync"
    fi

    # Get current upstream head
    local upstream_head
    upstream_head=$(git rev-parse "$UPSTREAM_BRANCH")
    log "Current upstream HEAD: $upstream_head"

    # Check if there are new commits
    if [[ "$last_hash" == "$upstream_head" ]]; then
        log "No new commits upstream - nothing to sync"
        return 0
    fi

    # Show what's new
    log "New commits upstream:"
    if [[ -n "$last_hash" ]]; then
        git log --oneline "$last_hash..$upstream_head" | tee -a "$LOG_FILE"
    else
        git log --oneline "$upstream_head" -10 | tee -a "$LOG_FILE"
    fi

    # Ensure we're on our branch
    log "Checking out $OUR_BRANCH..."
    git checkout "$OUR_BRANCH" || error "Failed to checkout $OUR_BRANCH"

    # Create temporary merge branch
    log "Creating temporary merge branch: $TEMP_MERGE_BRANCH"
    git checkout -b "$TEMP_MERGE_BRANCH" || error "Failed to create merge branch"

    # Attempt merge
    log "Attempting to merge $UPSTREAM_BRANCH..."
    if git merge "$UPSTREAM_BRANCH" --no-edit -m "Merge upstream changes from $upstream_head"; then
        log "✓ Clean merge - no conflicts"
    else
        log "⚠ Merge conflicts detected - attempting automatic resolution..."

        if ! resolve_conflicts_with_claude; then
            cleanup
            error "Failed to resolve conflicts - manual intervention required"
        fi

        # Commit the resolved merge
        log "Committing resolved merge..."
        git commit -m "Merge upstream changes from $upstream_head (conflicts resolved)" || error "Failed to commit resolved merge"
    fi

    # Verify build
    log "Verifying build..."
    if ! npm install 2>&1 | tee -a "$LOG_FILE"; then
        cleanup
        error "npm install failed after merge"
    fi

    if ! npm run build 2>&1 | tee -a "$LOG_FILE"; then
        cleanup
        error "Build failed after merge - aborting sync"
    fi

    log "✓ Build passed"

    # Merge looks good - update our branch
    log "Updating $OUR_BRANCH..."
    git checkout "$OUR_BRANCH" || error "Failed to checkout $OUR_BRANCH"
    git merge "$TEMP_MERGE_BRANCH" --ff-only || error "Failed to fast-forward merge"

    # Push to origin
    log "Pushing to origin..."
    if ! git push origin "$OUR_BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
        log "WARNING: Failed to push to origin - you may need to push manually"
    else
        log "✓ Pushed to origin"
    fi

    # Update sync hash
    echo "$upstream_head" > "$SYNC_HASH_FILE"
    log "Updated sync hash to: $upstream_head"

    # Cleanup
    cleanup

    # Send success notification
    local commit_count
    if [[ -n "$last_hash" ]]; then
        commit_count=$(git rev-list --count "$last_hash..$upstream_head")
    else
        commit_count="initial sync"
    fi
    send_notification "TinyClaw upstream sync completed successfully: $commit_count new commit(s) merged"

    log "=== Sync completed successfully ==="
}

# Set trap for cleanup on exit
trap cleanup EXIT

# Run main function
main "$@"
