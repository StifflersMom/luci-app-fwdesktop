// Backup round trip: download, change config on the router, restore from file, compare.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd]).toString();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="backup"] a'); };

  const before = ssh('uci export firewall; uci export fwdesktop');
  await open();
  const [ dl ] = await Promise.all([ p.waitForEvent('download'), p.click('button:has-text("Download backup")') ]);
  const file = path.join(out, dl.suggestedFilename()); await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // damage the config behind the app's back
  ssh('uci delete firewall.@zone[1]; uci add firewall rule >/dev/null; uci set firewall.@rule[-1].name=Bogus; uci delete fwdesktop.router; uci commit; fw4 reload 2>/dev/null; true');

  await open();
  const [ chooser ] = await Promise.all([ p.waitForEvent('filechooser'), p.click('button:has-text("Choose backup file")') ]);
  await chooser.setFiles(file);
  await p.waitForSelector('.modal table'); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, 'restore-dialog.png') });
  await p.click('.modal button:has-text("Restore and apply")');
  await p.waitForTimeout(15000);

  const after = ssh('uci export firewall; uci export fwdesktop');
  const norm = t => t.replace(/config (\w+) 'cfg[0-9a-f]+'/g, 'config $1').replace(/config (\w+)$/gm, 'config $1');
  console.log('file:', path.basename(file), 'sections:', data.configs.firewall.length, '+', data.configs.fwdesktop.length);
  console.log('identical after restore:', norm(before) == norm(after));
  if (norm(before) != norm(after)) fs.writeFileSync(path.join(out, 'before.txt'), norm(before)), fs.writeFileSync(path.join(out, 'after.txt'), norm(after));
  console.log('fw4:', ssh('fw4 check 2>&1 | tail -1').trim(), '| pending:', ssh('uci changes | wc -l').trim());
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
