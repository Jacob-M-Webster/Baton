#!/usr/bin/env bash
# Day-to-day commands for the Lightsail server.
#   ctl.sh ssh | logs | status | restart | url | backup
set -euo pipefail
. "$(dirname "$0")/config.sh"

case "${1:-}" in
  ssh)     shift; ssh "${ssh_opts[@]}" "ubuntu@$(server_ip)" "$@" ;;
  logs)    remote "sudo journalctl -u baton -u caddy -f -n 100" ;;
  status)  remote "systemctl --no-pager status baton caddy | head -30; df -h /opt/baton | tail -1; free -h | head -2" ;;
  restart) remote "sudo systemctl restart baton" && say "Restarted. Sessions resume from the log." ;;
  url)
    ip="$(server_ip)"
    code="$(sed -n 's/^BATON_ACCESS_CODE=//p' "$SERVER_ENV" 2>/dev/null | tr -d '\r"'"'" | head -1)"
    printf 'https://%s/?code=%s\n' "$(domain_for "$ip")" "$code" ;;
  backup)
    # Sessions, logs and workspaces from the server, as a tarball next to this script.
    out="$HERE/backup-$(date +%Y%m%d-%H%M%S).tgz"
    remote "sudo tar -czf - -C /opt/baton data" > "$out" && say "Saved $out" ;;
  *) echo "usage: $0 ssh|logs|status|restart|url|backup" >&2; exit 2 ;;
esac
