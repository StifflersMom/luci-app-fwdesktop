// Zone forwardings / input policies drawn as dashed lines.
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
  const n = await p.locator('.fwd-edge.policy').count();
  await p.screenshot({ path: out + '/policy-desktop.png' });
  const fwd = p.locator('.fwd-edge.policy').filter({ hasText: 'zone forwarding' }).first();
  await fwd.locator('.fwd-badge').hover(); await p.waitForSelector('.fwd-tooltip.visible'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/policy-tooltip.png' });
  await fwd.locator('.fwd-badge').click(); await p.waitForSelector('.modal .fwd-dialog-buttons', { state: 'visible' }); await p.waitForTimeout(400);
  await p.screenshot({ path: out + '/policy-dialog.png' });
  await p.click('.modal button:has-text("Close")'); await p.waitForTimeout(300);
  await p.click('button:has-text("Zone policies")'); await p.waitForTimeout(300);
  const n2 = await p.locator('.fwd-edge.policy').count();
  await p.click('button:has-text("Zone policies")'); await p.waitForTimeout(300);
  console.log('policy edges:', n, 'after toggle off:', n2, 'errors:', JSON.stringify(errs)); await b.close();
})();
