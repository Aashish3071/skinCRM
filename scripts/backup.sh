#!/usr/bin/env bash
# Encrypted database backup (PRD 9: "Daily encrypted backup").
#
#   BACKUP_PASSPHRASE=... scripts/backup.sh
#
# Writes backups/skincrm-<UTC timestamp>.dump.enc (pg_dump custom format,
# AES-256 with a PBKDF2-derived key), deletes backups older than
# BACKUP_RETENTION_DAYS (default 14), and records success in ops_heartbeats so
# the monitor alerts if backups stop (set BACKUPS_EXPECTED=true).
#
# Schedule daily, e.g. cron:  15 3 * * *  cd /srv/skincrm && scripts/backup.sh
# Copy the backups directory off the server (S3 with object lock, etc.).
source "$(dirname "$0")/lib/pg.sh"

: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE — keep it in a password manager, not on the server alone}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/skincrm-$stamp.dump.enc"
tmp="$out.partial"

# Stream: dump → encrypt → file. Nothing unencrypted touches the disk.
# shellcheck disable=SC2046
pg pg_dump $(pg_conn_args) --format=custom --no-owner --no-privileges "$PGDATABASE" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp"

# An empty or tiny file means the dump failed part-way.
size=$(wc -c < "$tmp" | tr -d ' ')
if [[ "$size" -lt 1024 ]]; then
  rm -f "$tmp"
  echo "Backup failed: output is only $size bytes" >&2
  exit 1
fi
mv "$tmp" "$out"
chmod 600 "$out"

find "$BACKUP_DIR" -name 'skincrm-*.dump.enc' -mtime +"$RETENTION" -delete

# shellcheck disable=SC2046
pg psql $(pg_conn_args) -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -c \
  "insert into ops_heartbeats (key, at, detail) values ('backup', now(), '$(basename "$out") ($size bytes)')
   on conflict (key) do update set at = excluded.at, detail = excluded.detail" >/dev/null

echo "Backup written: $out ($size bytes)"
