// Edit + delete flow on top of ui-flow.js state.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle');
  errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-edge'); await p.waitForTimeout(500);
  // edit SSH edge -> Drop + log
  await p.locator('.fwd-edge').filter({ hasText: 'HTTPS, DNS' }).first().locator('.fwd-badge').click();
  await p.waitForSelector('.modal .fwd-pair'); await p.click('.modal button:has-text("Edit")');
  await p.waitForSelector('.modal .fwd-form');
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) });
  await row('Action').locator('select').selectOption('DROP');
  await row('Log matches').locator('input[type=checkbox]').check();
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300); if (await p.locator('.modal .fwd-pair').count()) await p.click('.modal button:has-text(\"Close\")'); await p.waitForTimeout(300);
  // delete NAS
  const nas = p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: 'NAS' }) });
  await nas.locator('.fwd-box').dblclick(); await p.waitForSelector('.modal .fwd-form');
  await p.click('.modal button:has-text("Delete")'); await p.waitForTimeout(300);
  await p.click('.modal button.cbi-button-negative:has-text("Delete")'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/edit.png' });
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(8000);
  await p.click('li[data-tab="connections"] a'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/connections.png' });
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
