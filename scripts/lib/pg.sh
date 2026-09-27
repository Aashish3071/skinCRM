# Shared helpers for the backup scripts. Sourced, not run.
#
# Postgres tools come from the host if installed, otherwise from inside the
# database container (PG_CONTAINER, default skincrm-postgres) — which is how
# the production docker-compose setup runs them too.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  # Only the variables we need; never `source` the whole file into the shell.
  eval "$(grep -E '^(DATABASE_URL|BACKUP_[A-Z_]+|PG_CONTAINER)=' "$ROOT/.env" | sed 's/^/export /')" || true
fi

: "${DATABASE_URL:?DATABASE_URL (the owner connection) is required}"
PG_CONTAINER="${PG_CONTAINER:-skincrm-postgres}"

# postgresql://user:password@host:port/db
re='^postgres(ql)?://([^:]+):([^@]*)@([^:/]+):?([0-9]*)/([^?]+)'
[[ "$DATABASE_URL" =~ $re ]] || { echo "Cannot parse DATABASE_URL" >&2; exit 1; }
export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="${BASH_REMATCH[3]}" PGHOST="${BASH_REMATCH[4]}" PGPORT="${BASH_REMATCH[5]:-5432}" PGDATABASE="${BASH_REMATCH[6]}"

# pg <tool> [args…] — runs a Postgres client tool, host or container.
pg() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1; then
    "$tool" "$@"
  else
    docker exec -i -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" "$tool" -U "$PGUSER" "$@"
  fi
}

# Host tools need host/port; inside the container the defaults are right.
pg_conn_args() {
  if command -v pg_dump >/dev/null 2>&1; then echo "-h $PGHOST -p $PGPORT -U $PGUSER"; fi
}
