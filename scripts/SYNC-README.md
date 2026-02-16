# TinyClaw Upstream Sync System

This directory contains the automated upstream sync system that keeps our fork synchronized with the upstream TinyClaw repository while preserving our Baileys WhatsApp implementation.

## Overview

- **Fork**: `git@github.com:meanin2/tinyclaw.git` (branch: `corefind/baileys-whatsapp`)
- **Upstream**: `https://github.com/jlia0/tinyclaw.git` (branch: `main`)
- **Sync Frequency**: Every 6 hours (via systemd timer)

## Our Modifications

### WhatsApp Client (src/channels/whatsapp-client.ts)
We completely replaced the original `whatsapp-web.js` implementation with Baileys for:
- ARM64 compatibility
- Docker/headless server support
- No Chromium dependency
- More reliable authentication

**Critical**: The sync system will ALWAYS keep our version if upstream modifies this file.

### Package Dependencies
- **Added**: `baileys`, `@hapi/boom`, `pino`
- **Removed**: `whatsapp-web.js`

The sync system intelligently merges `package.json` changes while preserving our dependency modifications.

## Files

| File | Description |
|------|-------------|
| `upstream-sync.sh` | Main sync script |
| `sync.log` | Sync operation log |
| `.last-sync-hash` | Tracks last synced upstream commit |
| `conflicts.txt` | Generated during conflict resolution |

## How It Works

1. **Fetch**: Gets latest changes from `upstream/main`
2. **Compare**: Checks if there are new commits since last sync
3. **Merge**: Attempts to merge upstream changes
4. **Conflict Resolution**:
   - `whatsapp-client.ts` → Always keep ours
   - `package.json` → Smart merge using Claude Code CLI
   - Other files → Automatic resolution or abort
5. **Verification**: Runs `npm install && npm run build`
6. **Push**: Updates `origin/corefind/baileys-whatsapp` if successful
7. **Notify**: Sends WhatsApp notification on completion or failure

## Systemd Service

### Files
- `/etc/systemd/system/tinyclaw-upstream-sync.service` - Service definition
- `/etc/systemd/system/tinyclaw-upstream-sync.timer` - Timer (every 6 hours)

### Enable/Disable

```bash
# Enable automatic sync (starts timer)
sudo systemctl enable --now tinyclaw-upstream-sync.timer

# Disable automatic sync
sudo systemctl disable --now tinyclaw-upstream-sync.timer

# Check timer status
sudo systemctl status tinyclaw-upstream-sync.timer
sudo systemctl list-timers | grep tinyclaw

# View timer schedule
systemctl list-timers tinyclaw-upstream-sync.timer
```

### Manual Execution

```bash
# Run sync manually
cd /home/ubuntu/corefind/tinyclaw-fork
./scripts/upstream-sync.sh

# Or via systemd (useful for testing)
sudo systemctl start tinyclaw-upstream-sync.service

# View logs
sudo journalctl -u tinyclaw-upstream-sync.service -f
tail -f /home/ubuntu/corefind/tinyclaw-fork/scripts/sync.log
```

## Conflict Resolution Strategy

### Automatic Resolution

1. **whatsapp-client.ts**: Always keep our Baileys implementation
2. **package.json**: Claude-assisted smart merge:
   - Preserve: `baileys`, `@hapi/boom`, `pino`
   - Remove: `whatsapp-web.js` (if upstream re-adds it)
   - Merge: New upstream dependencies that don't conflict

### Manual Intervention Required

If conflicts cannot be auto-resolved:
1. Script aborts the merge
2. WhatsApp notification sent to `972548790112@s.whatsapp.net`
3. Conflict details saved to `scripts/conflicts.txt`
4. Manual resolution required:

```bash
cd /home/ubuntu/corefind/tinyclaw-fork
git checkout corefind/baileys-whatsapp

# Review conflicts
cat scripts/conflicts.txt

# Manually resolve
git merge upstream/main
# ... resolve conflicts ...
git commit

# Update sync hash
git rev-parse upstream/main > scripts/.last-sync-hash
```

## Logs and Monitoring

### View Recent Sync Activity

```bash
# Tail sync log
tail -50 /home/ubuntu/corefind/tinyclaw-fork/scripts/sync.log

# View systemd journal
sudo journalctl -u tinyclaw-upstream-sync.service -n 100 --no-pager

# Check last sync hash
cat /home/ubuntu/corefind/tinyclaw-fork/scripts/.last-sync-hash
```

### Check Upstream Status

```bash
cd /home/ubuntu/corefind/tinyclaw-fork
git fetch upstream
git log --oneline corefind/baileys-whatsapp..upstream/main
```

## Safety Features

### Conservative Approach
- Aborts on any uncertain situation
- Requires successful build before committing
- Never force-pushes
- Notifications on all failures

### Protected Files
- `whatsapp-client.ts` - Never accepts upstream changes
- `package.json` - Only merges non-conflicting deps

### Verification Steps
1. Merge validation
2. `npm install` success check
3. `npm run build` success check
4. Only then: commit and push

## Notifications

WhatsApp notifications sent to: `972548790112@s.whatsapp.net`

### Notification Types

| Trigger | Message |
|---------|---------|
| Success | "TinyClaw upstream sync completed successfully: X new commit(s) merged" |
| Conflict | "TinyClaw upstream sync: manual intervention needed - [reason]" |
| Build Failure | "TinyClaw upstream sync failed: Build failed after merge" |
| Push Failure | Warning logged (non-fatal) |

### Disable Notifications

Edit `upstream-sync.sh` and set:
```bash
WHATSAPP_TARGET=""  # Empty string disables notifications
```

## Dependencies

- **Git**: For repository operations
- **Node.js/npm**: For build verification
- **Claude Code CLI**: For intelligent conflict resolution
- **openclaw** (optional): For WhatsApp notifications
- **jq**: For JSON validation

## Troubleshooting

### Sync Fails with "Claude not found"

```bash
# Verify Claude Code CLI is installed
which claude
claude --version

# If missing, install from claude.ai
```

### Build Fails After Sync

1. Check `scripts/sync.log` for errors
2. Manually verify the merge:
   ```bash
   cd /home/ubuntu/corefind/tinyclaw-fork
   git log -1
   npm install
   npm run build
   ```
3. If build issues persist, may need to manually resolve

### Timer Not Running

```bash
# Check timer status
sudo systemctl status tinyclaw-upstream-sync.timer

# Check service status
sudo systemctl status tinyclaw-upstream-sync.service

# Reload systemd
sudo systemctl daemon-reload
sudo systemctl restart tinyclaw-upstream-sync.timer
```

### Reset Sync State

If you need to start fresh:

```bash
cd /home/ubuntu/corefind/tinyclaw-fork/scripts

# Backup current state
cp .last-sync-hash .last-sync-hash.backup 2>/dev/null || true

# Remove sync hash (next sync will be "initial")
rm -f .last-sync-hash

# Clean up logs if needed
> sync.log
```

## Development

### Test Conflict Resolution

Create a test conflict scenario:

```bash
cd /home/ubuntu/corefind/tinyclaw-fork

# Create test branch
git checkout -b test-sync

# Make conflicting change
echo "// test" >> src/channels/whatsapp-client.ts
git commit -am "Test conflict"

# Attempt merge
git merge upstream/main

# Test resolution logic
# ... script should keep our version ...
```

### Modify Sync Behavior

Edit `upstream-sync.sh`:

- Change sync strategy: Modify `resolve_conflicts_with_claude()` function
- Add file-specific rules: Add cases in conflict resolution
- Adjust notifications: Modify `send_notification()` calls
- Change verification: Update build verification steps

### Add New Protected Files

To protect additional files from upstream changes:

```bash
# In upstream-sync.sh, add to resolve_conflicts_with_claude():

if echo "$conflicted_files" | grep -q "path/to/file"; then
    log "WARNING: path/to/file has conflicts - keeping our version"
    git checkout --ours path/to/file
    git add path/to/file
    echo "RESOLVED: path/to/file (kept our version)" >> "$CONFLICT_FILE"
fi
```

## License

Same as TinyClaw (see parent repository).
