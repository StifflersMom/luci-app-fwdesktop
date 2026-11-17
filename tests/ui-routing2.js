// Routing rule: comment + enable toggle in the table.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd + '; true']).toString().trim();
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(400); await p.click('li[data-tab="routing"] a'); await p.waitForTimeout(200); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const apply = async () => { await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000); };
  const ruleRow = () => p.locator('div[data-tab="routing"] tr', { hasText: 'guest via table 100' }).first();

  await open();
  await p.click('button:has-text("+ IPv4 rule")'); await p.waitForSelector('.modal .fwd-form');
  await row('Comment').locator('input').fill('guest via table 100');
  await row('Priority').locator('input').fill('1300');
  await row('Source').locator('input').fill('192.168.99.0/24');
  const r = row('Routing table'); await r.locator('.cbi-dropdown').click(); const i = r.locator('.create-item-input').first(); await i.fill('100'); await i.press('Enter'); await p.click('.modal h4');
  await p.screenshot({ path: path.join(out, 'rule-dialog2.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  await apply();
  const a1 = ssh("ip -4 rule show | grep -c 1300; uci show network | grep comment");

  await open(); await ruleRow().locator('input[type=checkbox]').uncheck(); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'routing-toggle.png') });
  await apply();
  const a2 = ssh("ip -4 rule show | grep -c 1300; uci show network | grep disabled");

  await open(); await ruleRow().locator('input[type=checkbox]').check(); await p.waitForTimeout(500); await apply();
  const a3 = ssh("ip -4 rule show | grep -c 1300");

  await open(); await ruleRow().locator('button:has-text("Delete")').click(); await p.waitForTimeout(300); await apply();
  const a4 = ssh("ip -4 rule show | grep -c 1300; logread | grep -ci 'netifd.*\\(unknown\\|invalid\\)'");
  console.log('created:', JSON.stringify(a1)); console.log('disabled:', JSON.stringify(a2)); console.log('re-enabled:', JSON.stringify(a3)); console.log('deleted:', JSON.stringify(a4));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
