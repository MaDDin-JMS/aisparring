#!/usr/bin/env sh
# Deploy the current working tree to a VPS over SSH and (re)start it with Docker Compose.
#
#   deploy/deploy.sh            uses deploy/vps.env (git-ignored, see deploy/vps.env.example)
#
# Safety net:
#   1. the full test suite runs locally first (in Docker) — nothing is deployed if a test fails
#   2. the previous image is kept; if the new version does not become healthy, it is rolled back
#
# Needs: Docker locally (for the tests), ssh + tar (+ sshpass when using a password). If sshpass is
# missing (e.g. Git Bash on Windows) the script re-runs itself inside a small Alpine container.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-deploy/vps.env}
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy deploy/vps.env.example and fill it in." >&2; exit 1; }
# shellcheck disable=SC1090
. "./$ENV_FILE"
: "${VPS_HOST:?}" "${VPS_USER:=root}" "${VPS_DIR:=}" "${VPS_PASSWORD:=}" "${VPS_SSH_KEY:=}" "${VPS_DOMAIN:=}"

# Default folder. Installations from before the rename live in /opt/aichat — the server step below
# refuses to start a second, empty installation next to such an existing one.
DIR_DEFAULTED=
[ -n "$VPS_DIR" ] || { VPS_DIR=/opt/aisparring; DIR_DEFAULTED=1; }

# The upload step empties VPS_DIR on the server, so it must be a dedicated folder like /opt/aisparring.
# (The server side additionally refuses a non-empty folder that is not an AI Sparring installation.)
VPS_DIR=${VPS_DIR%/}
case "$VPS_DIR" in
  *..*|*' '*|*"'"*|*'"'*) bad_dir=1 ;;
  /?*/?*) bad_dir= ;;
  *) bad_dir=1 ;;
esac
if [ -n "$bad_dir" ]; then
  echo "VPS_DIR must be an absolute path to a dedicated folder, e.g. /opt/aisparring (got: '$VPS_DIR')." >&2
  exit 1
fi

if [ -z "${AISPARRING_TESTED:-}" ] && [ -z "${SKIP_TESTS:-}" ]; then
  echo "→ Running tests…"
  log=$(MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/src:ro" node:24-slim sh -c \
    'cp -r /src /tmp/w && cd /tmp/w && rm -rf node_modules && npm ci --no-audit --no-fund && npm test' 2>&1 || true)
  if ! printf '%s\n' "$log" | grep -q '^ℹ fail 0'; then
    printf '%s\n' "$log" | tail -40
    echo "✖ Tests failed — nothing was deployed." >&2
    exit 1
  fi
  printf '%s\n' "$log" | grep -E '^ℹ (tests|pass)' | sed 's/^/  /'
fi
export AISPARRING_TESTED=1

if [ -n "$VPS_PASSWORD" ] && ! command -v sshpass >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { echo "Need sshpass or Docker." >&2; exit 1; }
  exec env MSYS_NO_PATHCONV=1 docker run --rm -i -e AISPARRING_TESTED=1 -v "$(pwd -W 2>/dev/null || pwd):/src" -w /src alpine:3 \
    sh -c 'apk add -q --no-cache openssh-client sshpass tar >/dev/null && sh deploy/deploy.sh'
fi

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR"
[ -n "$VPS_SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $VPS_SSH_KEY"
remote() {
  if [ -n "$VPS_PASSWORD" ]; then SSHPASS="$VPS_PASSWORD" sshpass -e ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "$@"
  else ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "$@"; fi
}

echo "→ Preparing server $VPS_HOST…"
# Run through bash explicitly: the remote login shell may be zsh or something else.
remote bash -s -- "$VPS_DIR" "$DIR_DEFAULTED" <<'EOS'
set -e
dir=$1
if [ -n "$2" ] && [ ! -e "$dir" ] && [ -f /opt/aichat/docker-compose.yml ]; then
  echo "✖ Found an existing installation in /opt/aichat (from before the rename to AI Sparring)." >&2
  echo "  Set VPS_DIR=/opt/aichat in deploy/vps.env to keep updating it with its data." >&2
  exit 1
fi
if ! command -v docker >/dev/null; then
  echo "  Installing Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "  Installing Docker Compose…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || apt-get install -y -qq docker-compose >/dev/null
fi
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  port_of() { (grep -E "^$1=" "$dir/.env" 2>/dev/null || true) | tail -1 | cut -d= -f2; }
  http=$(port_of HTTP_PORT); https=$(port_of HTTPS_PORT)
  for p in "${http:-80}" "${https:-443}"; do ufw allow "$p/tcp" >/dev/null; done
fi
EOS

echo "→ Uploading…"
# Replace the code but keep the server's .env (data lives in Docker volumes, not here).
tar czf - --exclude=node_modules --exclude=data --exclude=.git --exclude='deploy/*.env' --exclude=.env . \
  | remote "if [ -n \"\$(ls -A '$VPS_DIR' 2>/dev/null)\" ] && [ ! -f '$VPS_DIR/docker-compose.yml' ]; then echo '✖ $VPS_DIR is not empty and is not an AI Sparring folder — refusing to replace its contents.' >&2; exit 1; fi \
      && mkdir -p '$VPS_DIR' && find '$VPS_DIR' -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} + && tar xzf - -C '$VPS_DIR' 2>/dev/null"

echo "→ Building and starting…"
remote bash -s -- "$VPS_DIR" "$VPS_DOMAIN" <<'EOS'
set -e
cd "$1"
[ -f .env ] || cp .env.example .env
[ -n "$2" ] && sed -i "s|^DOMAIN=.*|DOMAIN=$2|" .env
# Back up the live database first; never continue without a backup when data exists.
# (Before the rename the service was called "aichat"; its container is found by its Compose labels.)
running=""
for service in aisparring aichat; do
  running=$(docker ps -q --filter "label=com.docker.compose.project.working_dir=$PWD" --filter "label=com.docker.compose.service=$service" | head -1)
  [ -n "$running" ] && break
done
if [ -n "$running" ]; then
  docker exec -i "$running" node --input-type=module - < deploy/backup.mjs || { echo "✖ Backup failed — nothing changed."; exit 1; }
fi
# Keep the running version so we can go back to it.
if docker image inspect aisparring:latest >/dev/null 2>&1; then docker tag aisparring:latest aisparring:previous
elif docker image inspect aichat:latest >/dev/null 2>&1; then docker tag aichat:latest aisparring:previous
fi
docker compose --progress quiet build
docker compose --progress quiet up -d --remove-orphans

status=""
for _ in $(seq 1 30); do
  sleep 2
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q aisparring)" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
done
if [ "$status" != healthy ]; then
  echo "✖ New version is not healthy ($status). Logs:"
  docker compose logs --tail 40 aisparring
  if docker image inspect aisparring:previous >/dev/null 2>&1; then
    echo "→ Rolling back to the previous version…"
    docker tag aisparring:previous aisparring:latest
    docker compose up -d --no-build
  fi
  exit 1
fi
echo "  Healthy."
EOS

echo "→ Admin key (only on the very first start):"
remote "cd '$VPS_DIR' && docker compose exec -T aisparring aisparring initial-key --raw 2>/dev/null || echo '  (already retrieved — new admin key: docker compose exec aisparring aisparring key-add <name> --human --admin)'"

if [ -n "$VPS_DOMAIN" ]; then
  echo "→ Checking https://$VPS_DOMAIN …"
  ok=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if remote "curl -fsS --max-time 5 https://$VPS_DOMAIN/healthz >/dev/null 2>&1"; then ok=1; break; fi
    sleep 3
  done
  [ -n "$ok" ] || { echo "✖ https://$VPS_DOMAIN is not reachable (DNS, firewall or certificate?)." >&2; exit 1; }
fi
echo "✔ Done.${VPS_DOMAIN:+ https://$VPS_DOMAIN}"
