#!/usr/bin/env bash
# IP Call Panel - cPanel shared hosting helper (no root needed).
#
# 1. In cPanel open "Setup Node.js App" -> Create Application:
#      Node.js version: 22 (or the newest offered, minimum 18)
#      Application root: ip-call        (folder where you uploaded these files)
#      Application URL:  your domain or subdomain
#      Application startup file: app.js
# 2. Copy the "source .../activate" command shown at the top of that page, open cPanel -> Terminal, paste it, then:
#      cd ~/ip-call && bash install/cpanel-setup.sh
# 3. Back in "Setup Node.js App" click RESTART, then open your URL: the setup wizard appears.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> Node $(node -v) in $(pwd)"

major=$(node -v | cut -d. -f1 | tr -d v)
[[ $major -ge 18 ]] || { echo "Node 18+ required. Pick a newer version in Setup Node.js App."; exit 1; }

echo "==> Installing dependencies (this can take a few minutes)"
npm install --omit=dev --no-audit --no-fund || { echo "npm install failed"; exit 1; }

if node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "==> SQLite driver: better-sqlite3"
elif node -e "require('node:sqlite')" 2>/dev/null; then
  echo "==> better-sqlite3 could not be built here; using Node's built-in SQLite instead (fine)."
else
  echo "!! No SQLite driver available. Choose Node.js 22 in Setup Node.js App and run this again."; exit 1
fi

mkdir -p data/uploads
chmod 750 data
if [[ ! -f .env ]]; then
  echo "==> Creating .env"
  printf 'SESSION_SECRET=%s\nSECURE_COOKIES=1\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" > .env
  chmod 600 .env
fi
# Keep data/ and .env out of the public web root if the app folder is inside public_html.
if [[ "$(pwd)" == *public_html* ]]; then
  printf 'Require all denied\nDeny from all\n' > data/.htaccess
  echo "!! Warning: the app folder is inside public_html. Prefer a folder outside it (e.g. ~/ip-call)."
fi

mkdir -p tmp && touch tmp/restart.txt  # tells Passenger to restart
echo
echo "Done. Now:"
echo "  1. In cPanel -> Setup Node.js App, click RESTART for this app."
echo "  2. Open your app URL and complete the setup wizard."
echo "  3. In Admin -> Settings copy the cron command and add it in cPanel -> Cron Jobs (every minute)."
echo "Note: shared hosting cannot run Asterisk. Use Simulator mode, or point the panel at an Asterisk VPS"
echo "      installed with: sudo bash install/vps-install.sh --domain pbx.example.com --expose-ari"
