// Backup includes routing; restore lets you choose the parts.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd + '; true']).toString().trim();
(async () => {
  ssh("uci add network rule >/dev/null; uci set network.@rule[-1].src=192.168.55.0/24; uci set network.@rule[-1].lookup=100; uci set network.@rule[-1].priority=1500; uci set network.@rule[-1].comment=backup-test; uci commit network; /etc/init.d/network reload");
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="backup"] a'); };
  await open();
  const [ dl ] = await Promise.all([ p.waitForEvent('download'), p.click('button:has-text("Download backup")') ]);
  const file = path.join(out, dl.suggestedFilename()); await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // damage both parts
  ssh("uci delete network.@rule[-1]; uci commit network; uci add firewall rule >/dev/null; uci set firewall.@rule[-1].name=Bogus; uci set firewall.@rule[-1].src=lan; uci commit firewall; /etc/init.d/network reload; fw4 reload 2>/dev/null");
  const restore = async (keep) => {
    await open();
    const [ ch ] = await Promise.all([ p.waitForEvent('filechooser'), p.click('button:has-text("Choose backup file")') ]);
    await ch.setFiles(file); await p.waitForSelector('.modal table'); await p.waitForTimeout(300);
    const labels = p.locator('.modal label.fwd-radio');
    for (let i = 0; i < await labels.count(); i++) {
      const l = labels.nth(i), name = await l.locator('strong').innerText();
      const cb = l.locator('input[type=checkbox]');
      if (keep.includes(name)) await cb.check(); else await cb.uncheck();
    }
    await p.screenshot({ path: path.join(out, 'restore-parts.png') });
    await p.click('.modal button:has-text("Restore and apply")'); await p.waitForTimeout(15000);
  };
  await restore([ 'Routing' ]);
  const r1 = ssh("ip -4 rule show | grep -c 1500; uci show firewall | grep -c Bogus");
  await restore([ 'Firewall' ]);
  const r2 = ssh("ip -4 rule show | grep -c 1500; uci show firewall | grep -c Bogus; uci show network | grep -c '=interface'; fw4 check 2>&1 | tail -1; uci changes | wc -l");
  // cleanup the test rule
  ssh("for s in $(uci show network | grep \"comment='backup-test'\" | cut -d. -f2); do uci delete network.$s; done; uci commit network; /etc/init.d/network reload");
  console.log('backup parts:', Object.keys(data.configs).join(','), '| network sections:', data.configs.network.map(s => s['.type']).join(','));
  console.log('after routing-only restore (rule back, bogus kept):', JSON.stringify(r1));
  console.log('after firewall-only restore (rule kept, bogus gone, interfaces, fw4, pending):', JSON.stringify(r2));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
