#!/bin/sh
# Copy the app into the QEMU test VM (or any OpenWrt box: HOST/PORT env)
set -e
cd "$(dirname "$0")"
HOST=${HOST:-root@127.0.0.1}; PORT=${PORT:-2223}
SSH="ssh -i testvm/ssh_key -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=error"
tar -C luci-app-fwdesktop/htdocs -cf - . | $SSH $HOST 'tar -C /www -xf -'
tar -C luci-app-fwdesktop/root -cf - . | $SSH $HOST 'tar -C / -xf -'
$SSH $HOST 'sh /etc/uci-defaults/50-luci-fwdesktop && rm -f /etc/uci-defaults/50-luci-fwdesktop; /etc/init.d/rpcd reload'
echo deployed
