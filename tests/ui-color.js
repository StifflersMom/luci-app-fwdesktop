// Object colour: pick a colour, save, reload, colour persists; firewall config untouched by it.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500); };
  await open();
  const node = l => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: l }) });
  await node('LAN').locator('.fwd-box').dblclick(); await p.waitForSelector('.modal .fwd-color-row');
  const hex = p.locator('.modal .fwd-color-row input[type=text]');
  await hex.fill('#e05a2b'); await hex.dispatchEvent('input');
  await p.screenshot({ path: out + '/color-dialog.png' });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000);
  await open();
  const fill = await node('LAN').locator('.fwd-band').evaluate(e => getComputedStyle(e).fill);
  await p.screenshot({ path: out + '/color-desktop.png' });
  console.log('LAN band fill after reload:', fill, 'errors:', JSON.stringify(errs)); await b.close();
})();
