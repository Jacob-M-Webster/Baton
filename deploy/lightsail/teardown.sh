#!/usr/bin/env bash
# Delete the Lightsail instance, its static IP and key pair, so nothing keeps billing.
# Sessions on the server are lost; run `ctl.sh backup` first if you want them.
set -euo pipefail
. "$(dirname "$0")/config.sh"

printf 'This permanently deletes instance "%s", static IP "%s" and key pair "%s" in %s.\n' \
  "$BATON_INSTANCE" "$BATON_STATIC_IP" "$BATON_KEY_NAME" "$AWS_REGION"
read -r -p "Type the instance name to confirm: " answer
[ "$answer" = "$BATON_INSTANCE" ] || die "Not confirmed; nothing deleted."

aws_do lightsail delete-instance --instance-name "$BATON_INSTANCE" --force-delete-add-ons >/dev/null 2>&1 || say "No instance to delete"
aws_do lightsail release-static-ip --static-ip-name "$BATON_STATIC_IP" >/dev/null 2>&1 || say "No static IP to release"
aws_do lightsail delete-key-pair --key-pair-name "$BATON_KEY_NAME" >/dev/null 2>&1 || say "No key pair to delete"
[ "$DRY_RUN" = "1" ] || rm -f "$STATE"
say "Done. Your local key in $HERE/.ssh and server.env are kept."
