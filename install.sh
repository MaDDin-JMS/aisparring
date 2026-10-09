#!/usr/bin/env bash
# AI Sparring one-line installer for a fresh Linux VPS (Debian/Ubuntu/RHEL-family):
#
#   curl -fsSL https://raw.githubusercontent.com/MaDDin-JMS/aisparring/main/install.sh | sudo bash
#
# Installs Docker if needed, puts AI Sparring into /opt/aisparring, asks for your domain and starts it.
set -euo pipefail

REPO="${AISPARRING_REPO:-https://github.com/MaDDin-JMS/aisparring.git}"
# Installations from before the rename live in /opt/aichat; keep updating them there.
if [ -z "${AISPARRING_DIR:-}" ] && [ -d /opt/aichat/.git ] && [ ! -e /opt/aisparring ]; then AISPARRING_DIR=/opt/aichat; fi
DIR="${AISPARRING_DIR:-/opt/aisparring}"

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then
  say "Installing git…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf >/dev/null; then dnf install -y -q git
  else echo "Please install git first." >&2; exit 1; fi
fi

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR…"
  git -C "$DIR" pull --ff-only
else
  say "Downloading AI Sparring to $DIR…"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  domain="${AISPARRING_DOMAIN:-}"
  if [ -z "$domain" ] && [ -r /dev/tty ]; then
    echo
    echo "Which domain should AI Sparring use? Its DNS record must point to this server's IP."
    echo "Leave empty to use plain HTTP on the server IP for now."
    read -r -p "Domain: " domain < /dev/tty || true
  fi
  sed -i "s|^DOMAIN=.*|DOMAIN=${domain}|" .env
fi

say "Starting AI Sparring…"
docker compose up -d --build

say "Waiting for first start…"
key=""
for _ in $(seq 1 30); do
  docker compose logs aisparring 2>/dev/null | grep -q 'listening' && break
  sleep 2
done
# Prints the generated admin key once and deletes it on the server (empty on later runs).
key=$(docker compose exec -T aisparring aisparring initial-key --raw 2>/dev/null || true)

domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
ip=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
url=$([ -n "$domain" ] && echo "https://$domain" || echo "http://$ip")

echo
echo "────────────────────────────────────────────────────────────"
echo "  AI Sparring is running at: $url"
if [ -n "$key" ]; then
  echo
  echo "  Your admin key (shown only once — save it!):"
  echo
  echo "    $key"
  echo
  echo "  Log in directly: $url/?key=$key"
fi
echo
echo "  Admin CLI:  cd $DIR && docker compose exec aisparring aisparring --help"
echo "  Update:     cd $DIR && git pull && docker compose up -d --build"
echo "  Firewall:   make sure ports 80 and 443 are open."
echo "────────────────────────────────────────────────────────────"
