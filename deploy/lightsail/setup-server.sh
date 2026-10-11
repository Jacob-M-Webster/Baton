#!/bin/bash
# First-boot setup for the Lightsail instance (passed as user data, runs once as root).
# Installs Python, Caddy (HTTPS reverse proxy) and a systemd service. The app itself arrives with deploy.sh.
# Lightsail prepends its own #!/bin/sh snippet to user data, so this runs under sh, not bash: keep it POSIX.
set -eux
export DEBIAN_FRONTEND=noninteractive

# Caddy comes from Ubuntu's own archive: automatic HTTPS certificates, WebSockets out of the box. Its old
# Cloudsmith apt repository answers 402 Payment Required, so drop it if an earlier run added it.
rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
apt-get update
apt-get install -y python3 python3-venv python3-pip git curl caddy

# A small swap file keeps pip installs and test runs from tripping the OOM killer on 1 GB plans.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Baton runs as its own unprivileged user. Releases live in /opt/baton/releases, /opt/baton/app points
# at the current one, and sessions (the SQLite log and every workspace) live in /opt/baton/data.
id baton >/dev/null 2>&1 || useradd --system --home-dir /opt/baton --shell /usr/sbin/nologin baton
mkdir -p /opt/baton/releases /opt/baton/data
chown -R baton:baton /opt/baton
touch /opt/baton/baton.env && chmod 600 /opt/baton/baton.env   # read by systemd (as root) only

cat > /etc/systemd/system/baton.service <<'UNIT'
[Unit]
Description=Baton (shared agent sessions)
After=network-online.target
Wants=network-online.target

[Service]
User=baton
Group=baton
WorkingDirectory=/opt/baton/app
Environment=PYTHONPATH=backend BATON_HOST=127.0.0.1 BATON_PORT=8000 BATON_DATA_DIR=/opt/baton/data
EnvironmentFile=/opt/baton/baton.env
ExecStart=/opt/baton/venv/bin/python -m baton
Restart=always
RestartSec=2
# Agents (and whoever drives) run commands as this user. Keep them inside the data folder.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/baton/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable baton

# Until the first deploy, answer on port 80 so it's obvious the box is up.
cat > /etc/caddy/Caddyfile <<'CADDY'
:80 {
	respond "Baton is being installed. Run deploy/lightsail/deploy.sh." 503
}
CADDY
systemctl reload caddy || systemctl restart caddy
