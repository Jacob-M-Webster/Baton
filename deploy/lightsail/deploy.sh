#!/usr/bin/env bash
# Ship this working copy (committed or not) to the Lightsail server and restart Baton.
# Run it again whenever you want the server to match your laptop.
#
#   ./deploy/lightsail/deploy.sh
set -euo pipefail
. "$(dirname "$0")/config.sh"

# ---- Secrets: server.env holds API keys and the access code. Created on first deploy.
if [ ! -f "$SERVER_ENV" ]; then
  code="baton-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)"
  sed "s/^BATON_ACCESS_CODE=.*/BATON_ACCESS_CODE=$code/" "$HERE/server.env.example" > "$SERVER_ENV"
  say "Created $SERVER_ENV with access code $code. Add API keys there and run deploy.sh again."
fi
grep -q '^BATON_ACCESS_CODE=..*' "$SERVER_ENV" || die "Set BATON_ACCESS_CODE in $SERVER_ENV: the server runs commands for whoever drives."
code="$(sed -n 's/^BATON_ACCESS_CODE=//p' "$SERVER_ENV" | tr -d '\r"'"'" | head -1)"

IP="$(server_ip)"
DOMAIN="$(domain_for "$IP")"
REL="/opt/baton/releases/$(date +%Y%m%d-%H%M%S)"

# ---- The app: every tracked or new (not ignored) file, including the built web app in web/dist.
cd "$ROOT"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
git ls-files -co --exclude-standard | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done \
  | grep -v -e '^docs/baton-demo.mp4$' -e '^deploy/lightsail/server.env$' > "$list"
say "Uploading $(wc -l < "$list" | tr -d ' ') files to $IP"
tar -czf - -T "$list" | remote "sudo mkdir -p '$REL' && sudo tar -xzf - -C '$REL'"
tr -d '\r' < "$SERVER_ENV" | remote "cat > /tmp/baton.env && chmod 600 /tmp/baton.env"

say "Installing and restarting"
remote "sudo bash '$REL/deploy/lightsail/remote-install.sh' '$REL' '$DOMAIN'"

say "Checking https://$DOMAIN (the first deploy also fetches a certificate)"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/access" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || say "HTTPS isn't answering yet. Try in a minute, or: deploy/lightsail/ctl.sh logs"

cat <<DONE

  Baton is live at   https://$DOMAIN
  Access code        $code
  One-tap join link  https://$DOMAIN/?code=$code

  The Share button in any session gives a link and QR code that include the code.
  Logs: deploy/lightsail/ctl.sh logs    Shell: deploy/lightsail/ctl.sh ssh
DONE
