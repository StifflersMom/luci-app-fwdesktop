// Unsaved desktop changes survive navigating away; Save & Apply applies them; Reset discards.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd]).toString().trim();
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) }).first();
  const node = l => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: l }) });

  await open();
  // change 1: new host
  await p.click('.fwd-toolbar button.fwd-add.fwd-type-host'); await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('Persist-Test');
  await row('IP addresses').locator('.cbi-dropdown').click();
  const inp = row('IP addresses').locator('.create-item-input').first(); await inp.fill('10.0.2.123'); await inp.press('Enter');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(200);
  // change 2: move LAN
  const bb = await node('LAN').locator('.fwd-box').boundingBox();
  await p.mouse.move(bb.x + 60, bb.y + 30); await p.mouse.down(); await p.mouse.move(bb.x + 160, bb.y + 90, { steps: 8 }); await p.mouse.up();
  const lanPos = await node('LAN').getAttribute('transform');
  await p.waitForTimeout(1500);
  const status = await p.locator('.fwd-status').innerText();

  // leave and come back
  await p.goto(BASE + '/cgi-bin/luci/admin/network/network'); await p.waitForLoadState('networkidle');
  const pendingHeader = await p.locator('#ucichanges, .uci_change_indicator, [data-indicator="uci-changes"]').first().innerText().catch(() => '?');
  await open();
  const hostBack = await node('Persist-Test').count();
  const lanBack = await node('LAN').getAttribute('transform');
  const onRouterBefore = ssh("grep -c Persist-Test /etc/config/fwdesktop || true");

  // Reset discards
  await p.click('.cbi-page-actions .cbi-button-reset'); await p.waitForSelector('.modal'); await p.click('.modal button:has-text("Discard")');
  await p.waitForTimeout(6000); await open();
  const afterReset = await node('Persist-Test').count();

  console.log('status after edit:', JSON.stringify(status.split('\n').pop()));
  console.log('header indicator:', JSON.stringify(pendingHeader));
  console.log('host back after navigation:', hostBack, '| LAN position kept:', lanPos == lanBack, '| committed on router before apply:', onRouterBefore);
  console.log('host after Reset:', afterReset, '| pending after reset:', ssh('uci changes | wc -l'));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
