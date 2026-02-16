# TinyClaw Upstream Sync - Quick Reference

## One-Line Commands

```bash
# Check what's new upstream
./scripts/sync-control.sh check

# Sync now
./scripts/sync-control.sh sync

# Enable auto-sync (every 6 hours)
./scripts/sync-control.sh enable

# Disable auto-sync
./scripts/sync-control.sh disable

# View logs
./scripts/sync-control.sh logs

# Check timer status
./scripts/sync-control.sh status
```

## What Gets Protected

| File | Action |
|------|--------|
| `src/channels/whatsapp-client.ts` | **ALWAYS KEEP OURS** (Baileys implementation) |
| `package.json` | **SMART MERGE** (preserve baileys deps, merge upstream deps) |
| Other files | Auto-merge or abort on conflict |

## Our Dependencies (Never Removed)

- `baileys` - WhatsApp client library
- `@hapi/boom` - Baileys dependency
- `pino` - Baileys logging

## Notifications

WhatsApp messages sent to: `972548790112@s.whatsapp.net`

## Files

- `upstream-sync.sh` - Main sync script
- `check-upstream.sh` - Check status without syncing
- `sync-control.sh` - Control panel (recommended)
- `sync.log` - Operation log
- `.last-sync-hash` - Tracks last synced commit

## Systemd

```bash
# Enable
sudo systemctl enable --now tinyclaw-upstream-sync.timer

# Status
sudo systemctl status tinyclaw-upstream-sync.timer

# View schedule
systemctl list-timers | grep tinyclaw

# Manual run
sudo systemctl start tinyclaw-upstream-sync.service

# Logs
sudo journalctl -u tinyclaw-upstream-sync.service -f
```

## Troubleshooting

### "Claude not found"
```bash
which claude
# If missing, install Claude Code CLI
```

### Reset Sync State
```bash
./scripts/sync-control.sh reset
```

### Manual Conflict Resolution
```bash
cd /home/ubuntu/corefind/tinyclaw-fork
git merge upstream/main
# ... resolve conflicts ...
git commit
git rev-parse upstream/main > scripts/.last-sync-hash
```

## Safety Features

- Conservative: aborts on uncertainty
- Build verification: runs `npm install && npm run build`
- No force pushes
- Notifications on all failures
- Protected files never overwritten

## Full Documentation

See `scripts/SYNC-README.md` for complete documentation.
