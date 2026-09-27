#!/usr/bin/env bash
# Restore an encrypted backup into a database.
#
#   BACKUP_PASSPHRASE=... scripts/restore.sh backups/skincrm-<stamp>.dump.enc [target_db]
#
# target_db defaults to a NEW database named skincrm_restore_<stamp>, so a
# restore never overwrites the live database by accident. To replace
# production, stop the app, restore into a new database, check it, then point
# DATABASE_URL / DATABASE_APP_URL at it (and run `pnpm db:migrate` to re-apply
# roles and row-level security).
source "$(dirname "$0")/lib/pg.sh"

: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE}"
file="${1:?Usage: scripts/restore.sh <backup.dump.enc> [target_db]}"
target="${2:-skincrm_restore_$(date -u +%Y%m%d%H%M%S)}"
[[ "$target" == "$PGDATABASE" ]] && { echo "Refusing to restore over the live database '$PGDATABASE'." >&2; exit 1; }

# shellcheck disable=SC2046
pg psql $(pg_conn_args) -d postgres -v ON_ERROR_STOP=1 -q -c "create database \"$target\"" >/dev/null
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" \
  | pg pg_restore $(pg_conn_args) --no-owner --no-privileges --exit-on-error -d "$target"

echo "$target"
