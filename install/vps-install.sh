#!/usr/bin/env bash
# IP Call Panel - one-command VPS installer (Ubuntu 22.04 / 24.04, Debian 12). Run as root.
#
#   sudo bash install/vps-install.sh [--domain panel.example.com] [--email you@example.com]
#                                    [--no-asterisk] [--expose-ari] [--port 3000]
#
# Installs: Node.js 22, ffmpeg, nginx, (optional) Asterisk, the panel as a systemd service,
# firewall rules, and a Let's Encrypt certificate when --domain is given.
set -euo pipefail

DOMAIN=""; EMAIL=""; WITH_ASTERISK=1; EXPOSE_ARI=0; PORT=3000
APP_DIR=/opt/ip-call; APP_USER=ipcall
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-asterisk) WITH_ASTERISK=0; shift ;;
    --expose-ari) EXPOSE_ARI=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "Only Ubuntu/Debian are supported (found $ID)."; exit 1 ;; esac
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$SRC_DIR/package.json" ]] || { echo "Run this from inside the IP-Call folder."; exit 1; }
log() { echo -e "\n\033[1;34m==> $*\033[0m"; }
PUBLIC_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg build-essential python3 ffmpeg nginx ufw rsync
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

ARI_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
if [[ $WITH_ASTERISK -eq 1 ]]; then
  log "Installing Asterisk"
  apt-get install -y asterisk || { echo "Asterisk package not available on this release. Re-run with --no-asterisk or install Asterisk manually."; exit 1; }
  ETC=/etc/asterisk
  ts=$(date +%s)
  for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf; do
    [[ -f $ETC/$f ]] && cp -n "$ETC/$f" "$ETC/$f.bak-$ts" || true
    cp "$SRC_DIR/asterisk/$f" "$ETC/$f"
  done
  sed -i "s/^password = CHANGE_ME/password = $ARI_PASS/" $ETC/ari.conf
  sed -i "s/^;external_media_address=.*/;external_media_address=$PUBLIC_IP/; s/^;external_signaling_address=.*/;external_signaling_address=$PUBLIC_IP/" $ETC/pjsip.conf
  touch $ETC/pjsip_ipcall.conf
  # The legacy chan_sip driver (still shipped on some releases) would fight PJSIP for port 5060.
  grep -q '^noload => chan_sip.so' $ETC/modules.conf || sed -i '/^\[modules\]/a noload => chan_sip.so' $ETC/modules.conf
  mkdir -p /var/lib/asterisk/sounds/ipcall
fi

log "Creating app user and copying files to $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude .git "$SRC_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"
if [[ $WITH_ASTERISK -eq 1 ]]; then
  usermod -aG asterisk "$APP_USER"
  chown "$APP_USER":asterisk /etc/asterisk/pjsip_ipcall.conf; chmod 664 /etc/asterisk/pjsip_ipcall.conf
  chown asterisk:asterisk /var/lib/asterisk/sounds/ipcall; chmod 2775 /var/lib/asterisk/sounds/ipcall
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  log "Writing $APP_DIR/.env"
  {
    echo "PORT=$PORT"
    echo "SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
    [[ -n "$DOMAIN" ]] && echo "SECURE_COOKIES=1" && echo "PUBLIC_URL=https://$DOMAIN"
    if [[ $WITH_ASTERISK -eq 1 ]]; then
      echo "CALL_DRIVER=asterisk"
      echo "ARI_URL=http://127.0.0.1:8088"
      echo "ARI_USER=ipcall"
      echo "ARI_PASSWORD=$ARI_PASS"
      echo "ASTERISK_SOUNDS_DIR=/var/lib/asterisk/sounds/ipcall"
      echo "ASTERISK_PJSIP_FILE=/etc/asterisk/pjsip_ipcall.conf"
      echo "SIP_PUBLIC_HOST=${DOMAIN:-$PUBLIC_IP}"
    fi
  } > "$APP_DIR/.env"
else
  ARI_PASS="$(grep -oP '^ARI_PASSWORD=\K.*' "$APP_DIR/.env" || echo "$ARI_PASS")"
  [[ $WITH_ASTERISK -eq 1 ]] && sed -i "s/^password = .*/password = $ARI_PASS/" /etc/asterisk/ari.conf
fi
chmod 600 "$APP_DIR/.env"

log "Installing Node dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

log "Creating systemd service ip-call"
cat > /etc/systemd/system/ip-call.service <<UNIT
[Unit]
Description=IP Call Panel
After=network.target asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
$( [[ $WITH_ASTERISK -eq 1 ]] && echo "SupplementaryGroups=asterisk" )
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
[[ $WITH_ASTERISK -eq 1 ]] && { systemctl enable asterisk; systemctl restart asterisk; }
systemctl enable ip-call
systemctl restart ip-call

log "Configuring nginx"
SERVER_NAME="${DOMAIN:-_}"
ARI_BLOCK=""
if [[ $EXPOSE_ARI -eq 1 && $WITH_ASTERISK -eq 1 ]]; then
  ARI_BLOCK="
    # ARI for a panel hosted elsewhere (e.g. cPanel). Protected by the ARI username/password; use HTTPS.
    location /ari/ {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_read_timeout 1d;
    }"
fi
cat > /etc/nginx/sites-available/ip-call <<NGINX
server {
    listen 80;
    server_name $SERVER_NAME;
    client_max_body_size 25m;
$ARI_BLOCK
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/ip-call /etc/nginx/sites-enabled/ip-call
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

log "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
if [[ $WITH_ASTERISK -eq 1 ]]; then ufw allow 5060/udp >/dev/null; ufw allow 5060/tcp >/dev/null; ufw allow 10000:20000/udp >/dev/null; fi
ufw --force enable >/dev/null

if [[ -n "$DOMAIN" ]]; then
  log "Requesting HTTPS certificate for $DOMAIN"
  apt-get install -y certbot python3-certbot-nginx
  if [[ -n "$EMAIL" ]]; then CB_MAIL=(-m "$EMAIL"); else CB_MAIL=(--register-unsafely-without-email); fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${CB_MAIL[@]}" --redirect \
    || echo "Certificate failed (is DNS for $DOMAIN pointing at $PUBLIC_IP?). Re-run: certbot --nginx -d $DOMAIN"
fi

URL="http://${DOMAIN:-$PUBLIC_IP}"; [[ -n "$DOMAIN" ]] && URL="https://$DOMAIN"
echo
echo "=================================================================="
echo " IP Call Panel installed."
echo "   Open:            $URL   (the setup wizard starts automatically)"
echo "   Service:         systemctl status ip-call   |  logs: journalctl -u ip-call -f"
if [[ $WITH_ASTERISK -eq 1 ]]; then
echo "   Asterisk ARI:    user ipcall / password in $APP_DIR/.env (already filled in the wizard)"
echo "   Asterisk CLI:    asterisk -rvvv"
[[ $EXPOSE_ARI -eq 1 ]] && echo "   Remote ARI URL:  $URL   (use this in a panel hosted on cPanel)"
fi
echo "   Update later:    cd <new IP-Call folder> && sudo bash install/vps-install.sh ${DOMAIN:+--domain $DOMAIN}"
echo "=================================================================="
