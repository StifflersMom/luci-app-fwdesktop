// New routing table names: added to /etc/iproute2/rt_tables, used by netifd, part of the backup.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd + '; true']).toString().trim();
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  ssh('cp /etc/iproute2/rt_tables /tmp/rt_tables.orig');
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async (tab) => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="' + (tab || 'routing') + '"] a'); await p.waitForTimeout(200); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const table = async (val) => { const r = row('Routing table'); await r.locator('.cbi-dropdown').click(); const i = r.locator('.create-item-input').first(); await i.fill(val); await i.press('Enter'); await p.click('.modal h4'); };
  const pick = async (label) => { const r = row('Routing table'); await r.locator('.cbi-dropdown').click(); await r.locator('li', { hasText: label }).first().click(); await p.click('.modal h4'); };
  const apply = async () => { await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000); };

  await open();
  // rule with a new name, number changed from the proposal to 150
  await p.click('button:has-text("+ IPv4 rule")'); await p.waitForSelector('.modal .fwd-form');
  ok(!(await row('Table number').isVisible()), 'number row hidden for empty table');
  await row('Priority').locator('input').fill('1100');
  await row('Source').locator('input').fill('192.168.88.0/24');
  await table('dsl');
  ok(await row('Table number').isVisible(), 'number row shown for new name');
  ok(await row('Table number').locator('input').inputValue() == '100', 'proposes 100');
  await row('Table number').locator('input').fill('150');
  await p.screenshot({ path: path.join(out, 'rt-rule-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(2000);
  ok(/^150\tdsl$/m.test(ssh('cat /etc/iproute2/rt_tables')), 'rt_tables has 150 dsl after closing the dialog');

  // second rule: new name with a taken number is refused
  await p.click('button:has-text("+ IPv4 rule")'); await p.waitForSelector('.modal .fwd-form');
  await row('Source').locator('input').fill('192.168.89.0/24');
  await table('vpn');
  await row('Table number').locator('input').fill('150');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  ok(/already used by "dsl"/.test(await p.locator('.modal').innerText()), 'taken number refused');
  await p.click('.modal button:has-text("Cancel")'); await p.waitForTimeout(300);

  // route in table dsl, picked from the list
  await p.click('button:has-text("+ IPv4 route")'); await p.waitForSelector('.modal .fwd-form');
  await row('Interface').locator('select').selectOption('wan');
  await row('Target').locator('input').fill('0.0.0.0/0');
  await row('Gateway').locator('input').fill('10.0.2.2');
  await pick('dsl (150)');
  ok(!(await row('Table number').isVisible()), 'number row hidden for known name');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'rt-routing-tab.png'), fullPage: true });
  await apply();
  const live = ssh("ip -4 rule show | grep 1100; ip -4 route show table dsl");
  ok(/from 192\.168\.88\.0\/24 lookup dsl/.test(live), 'kernel rule uses table dsl');
  ok(/default via 10\.0\.2\.2/.test(live), 'kernel route in table dsl');

  // backup carries the name; restore adds it back
  await open('backup');
  const [ dl ] = await Promise.all([ p.waitForEvent('download'), p.click('button:has-text("Download backup")') ]);
  const file = path.join(out, dl.suggestedFilename()); await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(data.rt_tables && data.rt_tables.dsl == '150', 'backup has rt_tables dsl=150');
  ssh("sed -i '/dsl$/d;/added by Firewall Desktop/d' /etc/iproute2/rt_tables; while uci -q delete network.@rule[0]; do :; done; while uci -q delete network.@route[0]; do :; done; uci commit network; /etc/init.d/network reload");
  await open('backup');
  const [ ch ] = await Promise.all([ p.waitForEvent('filechooser'), p.click('button:has-text("Choose backup file")') ]);
  await ch.setFiles(file); await p.waitForSelector('.modal table'); await p.waitForTimeout(300);
  const labels = p.locator('.modal label.fwd-radio');
  for (let i = 0; i < await labels.count(); i++) {
    const l = labels.nth(i), cb = l.locator('input[type=checkbox]');
    if ((await l.locator('strong').innerText()) == 'Routing') await cb.check(); else await cb.uncheck();
  }
  await p.click('.modal button:has-text("Restore and apply")'); await p.waitForTimeout(15000);
  const r = ssh("grep -c '^150\tdsl$' /etc/iproute2/rt_tables; ip -4 rule show | grep 1100");
  ok(/^1\n.*lookup dsl/.test(r), 'restore re-adds dsl and the rule works');

  // cleanup
  ssh("while uci -q delete network.@rule[0]; do :; done; while uci -q delete network.@route[0]; do :; done; uci commit network; cp /tmp/rt_tables.orig /etc/iproute2/rt_tables; /etc/init.d/network reload");
  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
