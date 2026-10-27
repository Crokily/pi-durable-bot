#!/usr/bin/env bash
# Copy the tracked files of this checkout to the app directory, install dependencies,
# install the systemd unit, and (re)start the service. Uses sudo for systemctl and the unit file.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
app=${PERSONAL_BOT_APP_DIR:-$HOME/.local/lib/personal-bot}
node=$(mise which node 2>/dev/null || readlink -f "$(command -v node)")
unit=/etc/systemd/system/personal-bot.service

mkdir -p "$app"
rm -rf "$app/src" "$app/scripts" "$app/deploy" "$app/bin" "$app/config"
(cd "$repo" && git ls-files -z | tar --null -T - -cf -) | tar -C "$app" -xf -
(cd "$app" && npm ci --omit=dev --no-audit --no-fund)

sed -e "s|@USER@|$(id -un)|" -e "s|@APP@|$app|" -e "s|@NODE@|$node|" -e "s|@NODE_BIN@|$(dirname "$node")|" \
  "$repo/deploy/personal-bot.service" | sudo tee "$unit" >/dev/null
# pb for the agent's own scripts and cron jobs, with this node.
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nPERSONAL_BOT_NODE=%s exec %s/bin/pb "$@"\n' "$node" "$app" > "$HOME/.local/bin/pb"
chmod +x "$HOME/.local/bin/pb"

sudo systemctl daemon-reload
sudo systemctl enable personal-bot.service
sudo systemctl restart personal-bot.service
systemctl --no-pager status personal-bot.service | head -n 5
