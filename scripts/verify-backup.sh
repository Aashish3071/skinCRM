#!/usr/bin/env bash
# Restore test (PRD 9: "documented restore test before launch").
#
#   BACKUP_PASSPHRASE=... scripts/verify-backup.sh [backup.dump.enc]
#
# Restores the newest (or given) backup into a scratch database, compares row
# counts of the key tables with the live database, then drops the scratch
# copy. Counts may legitimately differ by a few rows written since the backup;
# a table that is empty in the copy but not live is a failure.
source "$(dirname "$0")/lib/pg.sh"

file="${1:-$(ls -t "${BACKUP_DIR:-$ROOT/backups}"/skincrm-*.dump.enc 2>/dev/null | head -1)}"
[[ -n "$file" && -f "$file" ]] || { echo "No backup file found." >&2; exit 1; }
echo "Verifying $file"

scratch="$("$(dirname "$0")/restore.sh" "$file" "skincrm_verify_$$" | tail -1)"
trap 'pg psql $(pg_conn_args) -d postgres -q -c "drop database if exists \"$scratch\"" >/dev/null' EXIT

tables=(clinics users people leads lead_stage_events appointments messages automation_rules audit_events)
failed=0
printf '%-22s %10s %10s\n' table live restored
for t in "${tables[@]}"; do
  # shellcheck disable=SC2046
  live=$(pg psql $(pg_conn_args) -d "$PGDATABASE" -tAc "select count(*) from $t")
  # shellcheck disable=SC2046
  copy=$(pg psql $(pg_conn_args) -d "$scratch" -tAc "select count(*) from $t")
  mark=""
  if [[ "$copy" -eq 0 && "$live" -gt 0 ]]; then mark="  <-- EMPTY IN BACKUP"; failed=1; fi
  printf '%-22s %10s %10s%s\n' "$t" "$live" "$copy" "$mark"
done

if [[ $failed -ne 0 ]]; then echo "RESTORE TEST FAILED" >&2; exit 1; fi
echo "Restore test passed."
