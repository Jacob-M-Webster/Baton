#!/bin/bash
# Runs on the server (as root) for each deploy: install a release, switch to it, restart.
#   remote-install.sh <release dir> <domain>
set -euo pipefail
REL="$1"
DOMAIN="$2"
cd "$REL"

# One shared virtualenv; pip only does work when requirements change.
[ -x /opt/baton/venv/bin/python ] || python3 -m venv /opt/baton/venv
/opt/baton/venv/bin/pip install -q --upgrade pip
/opt/baton/venv/bin/pip install -q -r requirements.txt

# Secrets: API keys and the access code, uploaded by deploy.sh. Readable by root only;
# systemd reads it before dropping to the baton user.
if [ -f /tmp/baton.env ]; then
  install -m 600 -o root -g root /tmp/baton.env /opt/baton/baton.env
  rm -f /tmp/baton.env
fi

chown -R baton:baton "$REL"
ln -sfn "$REL" /opt/baton/app

cat > /etc/caddy/Caddyfile <<CADDY
# Managed by deploy/lightsail/remote-install.sh
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8000
}
CADDY
systemctl reload caddy || systemctl restart caddy
systemctl restart baton

# Wait for the app to answer on its own port.
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/access >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8000/api/access >/dev/null || { journalctl -u baton -n 40 --no-pager; exit 1; }

# Keep the three newest releases.
ls -1dt /opt/baton/releases/* | tail -n +4 | xargs -r rm -rf
echo "Release $(basename "$REL") is live."
