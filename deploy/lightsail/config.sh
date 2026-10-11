# Shared settings for the Lightsail scripts. Override any of these in the environment, e.g.
#   AWS_REGION=us-west-2 BATON_RAM_GB=2 ./deploy/lightsail/launch.sh
# shellcheck shell=bash

: "${AWS_REGION:=us-east-1}"
: "${AWS_PROFILE:=}"                        # optional named profile from `aws configure` / `aws login`
: "${BATON_INSTANCE:=baton}"                # Lightsail instance name
: "${BATON_STATIC_IP:=${BATON_INSTANCE}-ip}"
: "${BATON_KEY_NAME:=${BATON_INSTANCE}-key}"
: "${BATON_RAM_GB:=1}"                      # 1 GB is plenty: the models run elsewhere (launch.sh prints the price)
: "${BATON_BUNDLE:=}"                       # an explicit Lightsail bundle id wins over BATON_RAM_GB
: "${BATON_DOMAIN:=}"                       # empty: <ip-with-dashes>.sslip.io, which needs no DNS setup
: "${DRY_RUN:=0}"                           # 1: print what would change on AWS instead of doing it

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEY_FILE="$HERE/.ssh/$BATON_KEY_NAME"
KNOWN_HOSTS="$HERE/.ssh/known_hosts"
STATE="$HERE/.state"                        # remembers the static IP between runs
SERVER_ENV="$HERE/server.env"               # API keys and the access code; never committed

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# The AWS CLI on Windows prints CRLF; strip it so values compare cleanly in bash.
aws_() {
  local args=(--region "$AWS_REGION")
  [ -n "$AWS_PROFILE" ] && args+=(--profile "$AWS_PROFILE")
  aws "${args[@]}" "$@" | tr -d '\r'
}

# Commands that change something on AWS go through here, so DRY_RUN=1 can show them instead.
aws_do() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry run] aws %s\n' "$*"
  else
    aws_ "$@"
  fi
}

# Paths handed to the Windows AWS CLI must be Windows paths (file://C:/...).
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

ssh_opts=(-i "$KEY_FILE" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS"
          -o ConnectTimeout=10 -o ServerAliveInterval=20)

load_state() { [ -f "$STATE" ] && . "$STATE"; true; }

server_ip() {
  load_state
  [ -n "${IP:-}" ] || IP="$(aws_ lightsail get-static-ip --static-ip-name "$BATON_STATIC_IP" --query 'staticIp.ipAddress' --output text 2>/dev/null || true)"
  [ -n "$IP" ] && [ "$IP" != "None" ] || die "No server yet. Run deploy/lightsail/launch.sh first."
  printf '%s' "$IP"
}

domain_for() { if [ -n "$BATON_DOMAIN" ]; then printf '%s' "$BATON_DOMAIN"; else printf '%s.sslip.io' "${1//./-}"; fi; }

remote() { ssh "${ssh_opts[@]}" "ubuntu@$(server_ip)" "$@"; }
