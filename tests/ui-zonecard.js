// Clicking a zone / the router shows its interfaces with addresses.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(800);
  const node = label => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: label }) });
  await node('Internet').locator('.fwd-box').click();
  await p.waitForSelector('.fwd-infocard.visible table'); await p.waitForTimeout(300);
  const wan = await p.locator('.fwd-infocard').innerText();
  await p.screenshot({ path: out + '/zonecard-wan.png' });
  await node('This router').locator('.fwd-box').click();
  await p.waitForSelector('.fwd-infocard.visible table'); await p.waitForTimeout(300);
  const rt = await p.locator('.fwd-infocard').innerText();
  await p.screenshot({ path: out + '/zonecard-router.png' });
  await p.click('.fwd-card-close'); await p.waitForTimeout(200);
  const closed = !(await p.locator('.fwd-infocard.visible').count());
  console.log('WAN:', JSON.stringify(wan)); console.log('ROUTER:', JSON.stringify(rt));
  console.log('closed:', closed, 'errors:', JSON.stringify(errs)); await b.close();
})();
