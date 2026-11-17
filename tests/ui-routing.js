// Policy routing: add route in table 100, IPv4 + IPv6 rules, apply, check ip rule/route, delete again.
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
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="routing"] a'); await p.waitForTimeout(200); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const table = async (val) => { const r = row('Routing table'); await r.locator('.cbi-dropdown').click(); const i = r.locator('.create-item-input').first(); await i.fill(val); await i.press('Enter'); await p.click('.modal h4'); };
  const apply = async () => { await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000); };

  await open();
  // route
  await p.click('button:has-text("+ IPv4 route")'); await p.waitForSelector('.modal .fwd-form');
  await row('Interface').locator('select').selectOption('wan');
  await row('Target').locator('input').fill('0.0.0.0/0');
  await row('Gateway').locator('input').fill('10.0.2.2');
  await table('100');
  await p.screenshot({ path: path.join(out, 'route-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  // IPv4 rule
  await p.click('button:has-text("+ IPv4 rule")'); await p.waitForSelector('.modal .fwd-form');
  await row('Priority').locator('input').fill('1000');
  await row('Source').locator('input').fill('192.168.77.0/24');
  await table('100');
  await p.screenshot({ path: path.join(out, 'rule-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  // IPv6 rule with action
  await p.click('button:has-text("+ IPv6 rule")'); await p.waitForSelector('.modal .fwd-form');
  await row('Priority').locator('input').fill('1001');
  await row('Source').locator('input').fill('fd00:77::/64');
  await row('Action').locator('select').selectOption('unreachable');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'routing-tab.png'), fullPage: true });
  await apply();
  const c1 = ssh("ip -4 rule show | grep 1000; ip -6 rule show | grep 1001; ip -4 route show table 100; uci changes | wc -l");

  // live view
  await open();
  await p.click('button:has-text("Show active rules and routes")'); await p.waitForTimeout(2000);
  const live = await p.locator('div[data-tab="routing"] .fwd-preview').first().innerText();

  // delete all three
  for (let i = 0; i < 3; i++) { await p.locator('div[data-tab="routing"] button:has-text("Delete")').first().click(); await p.waitForTimeout(300); }
  await apply();
  const c2 = ssh("ip -4 rule show | grep -c 'lookup 100'; ip -4 route show table 100 | wc -l; uci show network | grep -c '=rule\\|=route'; true");

  console.log('APPLIED:', JSON.stringify(c1)); console.log('LIVE first lines:', JSON.stringify(live.split('\n').slice(0, 3)));
  console.log('AFTER DELETE:', JSON.stringify(c2)); console.log('errors:', JSON.stringify(errs)); await b.close();
})();
