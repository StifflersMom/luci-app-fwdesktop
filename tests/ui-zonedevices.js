// Zone dialog: covered devices (list + custom wildcard) and covered subnets end up as fw4 zone options.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd]).toString();
const Z = "s=$(uci show firewall | grep \"name='vpn'\" | cut -d. -f2); ";
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="zones"] a'); await p.waitForTimeout(200); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const apply = async () => { await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000); };
  const zoneRow = n => p.locator('div[data-tab="zones"] .fwd-table tr', { has: p.locator('strong', { hasText: new RegExp('^' + n + '$') }) });

  await open();
  await p.click('button:has-text("+ New zone")'); await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('vpn');
  const dr = row('Covered devices');
  const opts = await dr.locator('.cbi-dropdown li[data-value]').evaluateAll(l => l.map(e => e.getAttribute('data-value')));
  await dr.locator('.cbi-dropdown').click();
  await dr.locator('.cbi-dropdown li[data-value="eth1"]').first().click();
  await dr.locator('input.create-item-input').fill('tun+'); await p.keyboard.press('Enter');
  await p.click('.modal h4');
  const sr = row('Covered subnets');
  await sr.locator('.add-item input[type=text]').fill('10.8.0.0/24'); await p.keyboard.press('Enter');
  await sr.locator('.add-item input[type=text]').fill('!10.8.0.128/25'); await p.keyboard.press('Enter');
  await p.screenshot({ path: path.join(out, 'zone-devices.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  const cell = await zoneRow('vpn').locator('td').nth(1).innerText();
  await apply();
  const c1 = ssh(Z + "uci get firewall.$s.device; uci get firewall.$s.subnet; fw4 check 2>&1 | tail -1; nft list ruleset | grep -E 'tun|10.8.0' | head -5");

  // edit: drop the devices again, keep subnets
  await open();
  await zoneRow('vpn').locator('button:has-text("Edit")').click(); await p.waitForSelector('.modal .fwd-form');
  const sel0 = await row('Covered devices').locator('.cbi-dropdown li[selected]').evaluateAll(l => l.map(e => e.getAttribute('data-value')));
  await row('Covered devices').locator('.cbi-dropdown').click();
  for (const v of [ 'eth1', 'tun+' ]) await row('Covered devices').locator('.cbi-dropdown li[data-value="' + v + '"]').first().click();
  await p.click('.modal h4');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  await apply();
  const c2 = ssh(Z + "uci -q get firewall.$s.device || echo nodevice; uci get firewall.$s.subnet");

  await open();
  await zoneRow('vpn').locator('button:has-text("Delete")').click(); await p.waitForSelector('.modal'); await p.waitForTimeout(200);
  await p.click('.modal button.cbi-button-negative:has-text("Delete")'); await p.waitForTimeout(300);
  await apply();
  console.log('device options:', JSON.stringify(opts));
  console.log('zones cell:', JSON.stringify(cell));
  console.log('CREATE:', JSON.stringify(c1));
  console.log('reopen selected:', JSON.stringify(sel0)); console.log('EDIT:', JSON.stringify(c2));
  console.log('left:', ssh("uci show firewall | grep -c vpn; true"));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
