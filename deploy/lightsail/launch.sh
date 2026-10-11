#!/usr/bin/env bash
# Create (or reuse) everything Baton needs on Lightsail, then deploy it:
#   an SSH key pair, a Linux instance, a static IP, firewall rules for 22/80/443.
# Safe to run again: existing resources are reused. DRY_RUN=1 shows the AWS changes without making them.
#
#   ./deploy/lightsail/launch.sh
set -euo pipefail
. "$(dirname "$0")/config.sh"

command -v aws >/dev/null || die "Install the AWS CLI v2 first: https://aws.amazon.com/cli/"
command -v ssh >/dev/null && command -v ssh-keygen >/dev/null || die "Needs ssh and ssh-keygen (Git Bash has both)."
who="$(aws_ sts get-caller-identity --query Arn --output text 2>/dev/null)" \
  || die "The AWS CLI isn't signed in. Run 'aws login' (or 'aws configure'), then try again."
say "AWS identity: $who (region $AWS_REGION)"

# ---- SSH key: generated here, imported into Lightsail; the private half never leaves this folder.
mkdir -p "$HERE/.ssh"
if [ ! -f "$KEY_FILE" ]; then
  say "Creating SSH key $KEY_FILE"
  ssh-keygen -q -t rsa -b 4096 -N "" -C "baton-lightsail" -f "$KEY_FILE"
fi
chmod 600 "$KEY_FILE" 2>/dev/null || true
if ! aws_ lightsail get-key-pair --key-pair-name "$BATON_KEY_NAME" >/dev/null 2>&1; then
  say "Importing key pair $BATON_KEY_NAME"
  aws_do lightsail import-key-pair --key-pair-name "$BATON_KEY_NAME" \
    --public-key-base64 "file://$(native_path "$KEY_FILE.pub")" >/dev/null
fi

# ---- Instance
state="$(aws_ lightsail get-instance --instance-name "$BATON_INSTANCE" --query 'instance.state.name' --output text 2>/dev/null || true)"
if [ -z "$state" ]; then
  blueprint="$(aws_ lightsail get-blueprints --output text \
    --query "blueprints[?platform=='LINUX_UNIX' && starts_with(blueprintId, 'ubuntu_24')].blueprintId | [0]")"
  [ -n "$blueprint" ] && [ "$blueprint" != "None" ] || die "No Ubuntu 24.04 blueprint in $AWS_REGION."
  bundle="$BATON_BUNDLE"
  if [ -z "$bundle" ]; then
    # The cheapest current dual-stack Linux plan with the requested memory.
    bundle="$(aws_ lightsail get-bundles --output text --query \
      "sort_by(bundles[?isActive && ramSizeInGb==\`$BATON_RAM_GB\` && contains(supportedPlatforms, 'LINUX_UNIX') && !contains(bundleId, 'ipv6')], &price)[0].bundleId")"
  fi
  [ -n "$bundle" ] && [ "$bundle" != "None" ] || die "No Lightsail plan with ${BATON_RAM_GB} GB of memory; set BATON_BUNDLE."
  price="$(aws_ lightsail get-bundles --output text --query "bundles[?bundleId=='$bundle'].price | [0]")"
  say "Creating instance $BATON_INSTANCE ($blueprint, $bundle, \$$price/month) in ${AWS_REGION}a"
  aws_do lightsail create-instances --instance-names "$BATON_INSTANCE" --availability-zone "${AWS_REGION}a" \
    --blueprint-id "$blueprint" --bundle-id "$bundle" --key-pair-name "$BATON_KEY_NAME" \
    --user-data "file://$(native_path "$HERE/setup-server.sh")" --tags key=project,value=baton >/dev/null
else
  say "Instance $BATON_INSTANCE already exists ($state)"
fi

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run: would wait for the instance, attach static IP $BATON_STATIC_IP, open ports 22/80/443, and deploy."
  exit 0
fi

say "Waiting for the instance to start"
for _ in $(seq 1 60); do
  [ "$(aws_ lightsail get-instance --instance-name "$BATON_INSTANCE" --query 'instance.state.name' --output text)" = "running" ] && break
  sleep 5
done

# ---- Static IP, so the address (and the HTTPS certificate) survive restarts.
if ! aws_ lightsail get-static-ip --static-ip-name "$BATON_STATIC_IP" >/dev/null 2>&1; then
  say "Allocating static IP $BATON_STATIC_IP"
  aws_ lightsail allocate-static-ip --static-ip-name "$BATON_STATIC_IP" >/dev/null
fi
attached="$(aws_ lightsail get-static-ip --static-ip-name "$BATON_STATIC_IP" --query 'staticIp.attachedTo' --output text)"
if [ "$attached" != "$BATON_INSTANCE" ]; then
  say "Attaching static IP to $BATON_INSTANCE"
  aws_ lightsail attach-static-ip --static-ip-name "$BATON_STATIC_IP" --instance-name "$BATON_INSTANCE" >/dev/null
fi
IP="$(aws_ lightsail get-static-ip --static-ip-name "$BATON_STATIC_IP" --query 'staticIp.ipAddress' --output text)"
printf 'IP=%s\n' "$IP" > "$STATE"

# ---- Firewall: SSH, and HTTP/HTTPS for Caddy. Port 8000 stays closed; Baton only listens on localhost.
say "Opening ports 22, 80 and 443"
aws_ lightsail put-instance-public-ports --instance-name "$BATON_INSTANCE" --port-infos \
  "fromPort=22,toPort=22,protocol=tcp" "fromPort=80,toPort=80,protocol=tcp" "fromPort=443,toPort=443,protocol=tcp" >/dev/null

say "Waiting for SSH and first-boot setup on $IP (a few minutes on a new instance)"
for i in $(seq 1 60); do
  if ssh "${ssh_opts[@]}" -o BatchMode=yes "ubuntu@$IP" "cloud-init status --wait >/dev/null 2>&1; test -f /etc/systemd/system/baton.service" 2>/dev/null; then
    break
  fi
  [ "$i" = 60 ] && die "The server didn't finish setting up. Check: ssh -i $KEY_FILE ubuntu@$IP 'sudo tail -50 /var/log/cloud-init-output.log'"
  sleep 10
done

exec "$HERE/deploy.sh"
