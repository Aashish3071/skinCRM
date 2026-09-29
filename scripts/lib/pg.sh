# Shared helpers for the backup scripts. Sourced, not run.
#
# Where Postgres runs, in order of preference:
#   1. PG_CONTAINER, if set (a container name or id);
#   2. the `postgres` service of the production compose stack
#      (deploy/docker-compose.prod.yml), if it is running;
#   3. the development container `skincrm-postgres`, if it is running;
#   4. Postgres client tools on the host, connecting over TCP.
# The production stack does not publish the database port, so on a server the
# tools always run inside the container.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Read only the variables we need from .env, as plain data. Never `source` or
# `eval` it: a password containing $, ` or ; would be run as shell code.
# Values already in the environment win, so they can be overridden per run.
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^(DATABASE_URL|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|PG_CONTAINER|BACKUP_[A-Z_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # Strip one pair of surrounding quotes, as dotenv does.
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    if [[ -z "${!key:-}" ]]; then export "$key=$value"; fi
  done < "$ROOT/.env"
fi

# Percent-decode a URL component (passwords from `openssl rand -base64` often
# contain / + = and must be encoded in the URL).
urldecode() { local s="${1//+/%2B}"; printf '%b' "${s//%/\\x}"; }

if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
  # Production: the compose stack builds its URLs from these, and the
  # DATABASE_URL left in .env from .env.example points at a dev database.
  PGUSER="${POSTGRES_USER:-skincrm}"
  PGPASSWORD="$POSTGRES_PASSWORD"
  PGHOST="localhost"
  PGPORT="5432"
  PGDATABASE="${POSTGRES_DB:-skincrm}"
else
  : "${DATABASE_URL:?Set DATABASE_URL (development) or POSTGRES_PASSWORD (production) in .env}"
  # postgresql://user:password@host:port/db?params
  re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
  [[ "$DATABASE_URL" =~ $re ]] || { echo "Cannot parse DATABASE_URL" >&2; exit 1; }
  PGUSER="$(urldecode "${BASH_REMATCH[2]}")"
  PGPASSWORD="$(urldecode "${BASH_REMATCH[4]}")"
  PGHOST="${BASH_REMATCH[5]}"
  PGPORT="${BASH_REMATCH[7]:-5432}"
  PGDATABASE="$(urldecode "${BASH_REMATCH[8]}")"
fi
export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE

running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

PG_TARGET=""
if command -v docker >/dev/null 2>&1; then
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    running "$PG_CONTAINER" || { echo "PG_CONTAINER=$PG_CONTAINER is not running" >&2; exit 1; }
    PG_TARGET="$PG_CONTAINER"
  else
    prod_id="$(docker compose -f "$ROOT/deploy/docker-compose.prod.yml" --env-file "$ROOT/.env" ps -q postgres 2>/dev/null || true)"
    if [[ -n "$prod_id" ]] && running "$prod_id"; then
      PG_TARGET="$prod_id"
    elif running skincrm-postgres; then
      PG_TARGET="skincrm-postgres"
    fi
  fi
fi
if [[ -z "$PG_TARGET" ]] && ! command -v pg_dump >/dev/null 2>&1; then
  echo "No running Postgres container found and no pg_dump on this host. Set PG_CONTAINER." >&2
  exit 1
fi

# pg <tool> [args…] — runs a Postgres client tool in the container, or on the host.
pg() {
  local tool="$1"; shift
  if [[ -n "$PG_TARGET" ]]; then
    docker exec -i -e PGPASSWORD="$PGPASSWORD" "$PG_TARGET" "$tool" -U "$PGUSER" "$@"
  else
    "$tool" "$@"
  fi
}

# Host tools need host/port/user; inside the container the socket defaults are right.
pg_conn_args() {
  if [[ -z "$PG_TARGET" ]]; then echo "-h $PGHOST -p $PGPORT -U $PGUSER"; fi
}
