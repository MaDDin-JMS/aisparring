#!/usr/bin/env sh
# Deploy the current working tree to a VPS over SSH and (re)start it with Docker Compose.
#
#   deploy/deploy.sh            uses deploy/vps.env (git-ignored, see deploy/vps.env.example)
#
# Needs: ssh + tar (+ sshpass when using a password). If sshpass is missing (e.g. Git Bash on
# Windows) the script re-runs itself inside a small Alpine container — Docker is enough.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-deploy/vps.env}
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy deploy/vps.env.example and fill it in." >&2; exit 1; }
# shellcheck disable=SC1090
. "./$ENV_FILE"
: "${VPS_HOST:?}" "${VPS_USER:=root}" "${VPS_DIR:=/opt/aichat}" "${VPS_PASSWORD:=}" "${VPS_SSH_KEY:=}"

if [ -n "$VPS_PASSWORD" ] && ! command -v sshpass >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { echo "Need sshpass or Docker." >&2; exit 1; }
  echo "→ sshpass not found, running inside Docker…"
  exec env MSYS_NO_PATHCONV=1 docker run --rm -i -v "$(pwd -W 2>/dev/null || pwd):/src" -w /src alpine:3 \
    sh -c 'apk add -q --no-cache openssh-client sshpass tar >/dev/null && sh deploy/deploy.sh'
fi

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
[ -n "$VPS_SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $VPS_SSH_KEY"
remote() {
  if [ -n "$VPS_PASSWORD" ]; then SSHPASS="$VPS_PASSWORD" sshpass -e ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "$@"
  else ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "$@"; fi
}

echo "→ Checking server $VPS_HOST…"
remote 'command -v docker >/dev/null || (echo "Installing Docker…" && curl -fsSL https://get.docker.com | sh >/dev/null)'

echo "→ Uploading to $VPS_DIR…"
tar czf - --exclude=node_modules --exclude=data --exclude=.git --exclude='deploy/*.env' --exclude=.env . \
  | remote "mkdir -p '$VPS_DIR' && tar xzf - -C '$VPS_DIR'"

echo "→ Starting…"
remote "cd '$VPS_DIR' && { [ -f .env ] || cp .env.example .env; } && docker compose up -d --build --remove-orphans && sleep 3 && docker compose ps"

echo
echo "→ Admin key (only present on the very first start):"
remote "cd '$VPS_DIR' && docker compose logs aichat 2>/dev/null | grep -A2 'First start' | grep -o 'aic_[A-Za-z0-9_-]*' || echo '  (already initialised — create a new one with: docker compose exec aichat aichat key-add <name> --human --admin)'"
echo
echo "Done. Edit $VPS_DIR/.env on the server to set DOMAIN, then run this script again."
