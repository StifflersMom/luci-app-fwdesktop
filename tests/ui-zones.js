// Zone management: create (with forwarding + desktop object), rename, delete.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd]).toString();
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="zones"] a'); await p.waitForTimeout(200); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) }).first();
  const pick = async (label, value) => { const r = row(label); await r.locator('.cbi-dropdown').click(); await r.locator('.cbi-dropdown li[data-value="' + value + '"]').first().click(); await p.keyboard.press('Escape').catch(()=>{}); await p.click('.modal h4'); };
  const apply = async () => { await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000); };
  const zoneRow = n => p.locator('div[data-tab="zones"] .fwd-table tr', { has: p.locator('strong', { hasText: new RegExp('^' + n + '$') }) });

  // create
  await open();
  await p.click('button:has-text("+ New zone")'); await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('guest');
  await row('Forward').locator('select').selectOption('REJECT');
  await pick('Covered networks', 'guest');
  await pick('Allow forward to', 'wan');
  await p.screenshot({ path: path.join(out, 'zone-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  await apply();
  const c1 = ssh("uci show firewall | grep -A0 \"name='guest'\"; uci show firewall | grep forwarding -A2 | grep -c guest; grep -c \"zone 'guest'\" /etc/config/fwdesktop; fw4 check 2>&1 | tail -1");

  // rename
  await open();
  await zoneRow('guest').locator('button:has-text("Edit")').click(); await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('visitors');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  await apply();
  const c2 = ssh("uci show firewall | grep -c \"'visitors'\"; uci show firewall | grep -c \"'guest'\"; grep -c \"zone 'visitors'\" /etc/config/fwdesktop; fw4 check 2>&1 | tail -1");

  // delete
  await open();
  await zoneRow('visitors').locator('button:has-text("Delete")').click(); await p.waitForSelector('.modal'); await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(out, 'zone-delete.png') });
  await p.click('.modal button.cbi-button-negative:has-text("Delete")'); await p.waitForTimeout(300);
  await apply();
  const c3 = ssh("uci show firewall | grep -c visitors; grep -c visitors /etc/config/fwdesktop; fw4 check 2>&1 | tail -1; uci changes | wc -l");

  console.log('CREATE:', JSON.stringify(c1)); console.log('RENAME:', JSON.stringify(c2)); console.log('DELETE:', JSON.stringify(c3));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
