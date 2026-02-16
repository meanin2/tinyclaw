# TinyClaw Upstream Sync System - Files Created

This document lists all files created for the upstream sync system.

## Scripts (`/home/ubuntu/corefind/tinyclaw-fork/scripts/`)

| File | Purpose | Executable |
|------|---------|------------|
| `upstream-sync.sh` | Main sync script - fetches, merges, resolves conflicts, verifies build | Yes |
| `check-upstream.sh` | Quick status check - shows what's new without syncing | Yes |
| `sync-control.sh` | Control panel - unified interface for all sync operations | Yes |
| `preflight-check.sh` | Environment validation - checks dependencies and configuration | Yes |

## Systemd Files (`/etc/systemd/system/`)

| File | Purpose |
|------|---------|
| `tinyclaw-upstream-sync.service` | Systemd service unit - runs sync script |
| `tinyclaw-upstream-sync.timer` | Systemd timer - schedules sync every 6 hours |

## Documentation (`/home/ubuntu/corefind/tinyclaw-fork/scripts/`)

| File | Purpose |
|------|---------|
| `SYNC-README.md` | Complete documentation - how it works, usage, troubleshooting |
| `QUICK-REFERENCE.md` | Quick reference card - most common commands and info |
| `FILES-CREATED.md` | This file - inventory of created files |

## Generated Files (Created at Runtime)

These files are created/updated automatically by the sync system:

| File | Purpose | In Git |
|------|---------|--------|
| `scripts/sync.log` | Sync operation log | No (gitignored) |
| `scripts/.last-sync-hash` | Tracks last synced upstream commit | No (gitignored) |
| `scripts/conflicts.txt` | Generated during conflict resolution | No (gitignored) |

## Modified Files

| File | Change |
|------|--------|
| `.gitignore` | Added sync state files to ignore list |

## Quick Start

```bash
# Check environment
./scripts/preflight-check.sh

# Check what's new
./scripts/sync-control.sh check

# Run sync
./scripts/sync-control.sh sync

# Enable automatic sync (every 6 hours)
./scripts/sync-control.sh enable
```

## Architecture

```
┌─────────────────────────────────────────┐
│     Systemd Timer (every 6 hours)       │
│   tinyclaw-upstream-sync.timer          │
└──────────────┬──────────────────────────┘
               │
               ├─> triggers
               ▼
┌─────────────────────────────────────────┐
│     Systemd Service                      │
│   tinyclaw-upstream-sync.service        │
└──────────────┬──────────────────────────┘
               │
               ├─> executes
               ▼
┌─────────────────────────────────────────┐
│     Main Sync Script                     │
│   upstream-sync.sh                       │
│                                          │
│  1. Fetch upstream                       │
│  2. Check for new commits                │
│  3. Attempt merge                        │
│  4. Resolve conflicts (Claude-assisted)  │
│  5. Verify build                         │
│  6. Push to origin                       │
│  7. Update .last-sync-hash               │
│  8. Send notifications                   │
└─────────────────────────────────────────┘
```

## File Permissions

All scripts should be executable:

```bash
chmod +x /home/ubuntu/corefind/tinyclaw-fork/scripts/*.sh
```

Systemd files are owned by root (created with sudo).

## Dependencies

- Git
- Node.js / npm
- Claude Code CLI (for conflict resolution)
- jq (for JSON validation)
- openclaw (optional, for WhatsApp notifications)

## Configuration

No separate config file needed. All settings are embedded in `upstream-sync.sh`:

- `REPO_DIR`: `/home/ubuntu/corefind/tinyclaw-fork`
- `OUR_BRANCH`: `corefind/baileys-whatsapp`
- `UPSTREAM_BRANCH`: `upstream/main`
- `WHATSAPP_TARGET`: `972548790112@s.whatsapp.net`

To change settings, edit `upstream-sync.sh` directly.

## Testing

Before enabling the timer, test manually:

```bash
# 1. Preflight check
./scripts/preflight-check.sh

# 2. Check upstream
./scripts/check-upstream.sh

# 3. Dry-run test
./scripts/sync-control.sh test

# 4. Manual sync
./scripts/sync-control.sh sync

# 5. If successful, enable timer
./scripts/sync-control.sh enable
```

## Monitoring

View logs in real-time:

```bash
# Application log
tail -f /home/ubuntu/corefind/tinyclaw-fork/scripts/sync.log

# Systemd journal
sudo journalctl -u tinyclaw-upstream-sync.service -f
```

## Maintenance

### Update Sync Script

After modifying `upstream-sync.sh`, reload systemd:

```bash
sudo systemctl daemon-reload
```

### Clear Sync History

To force a "fresh" sync:

```bash
./scripts/sync-control.sh reset
```

### Disable Sync

```bash
./scripts/sync-control.sh disable
```

## Security

- Scripts run as user `ubuntu`
- Protected paths in systemd service (ReadWritePaths)
- Resource limits (CPUQuota=50%, MemoryMax=2G)
- Security hardening (NoNewPrivileges, PrivateTmp, ProtectSystem)

## Next Steps

1. Run preflight check
2. Test manual sync
3. Enable timer if successful
4. Monitor first few automatic syncs
5. Adjust schedule if needed (edit `.timer` file)

## Support

See `SYNC-README.md` for complete documentation and troubleshooting.
