// Usage: node tests/ui-smoke.js [outdir]
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  p.on('console', m => { if (m.type() == 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/');
  await p.fill('input[name=luci_password]', 'test1234');
  await p.click('button.cbi-button-positive, input[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop');
  await p.waitForSelector('.fwd-canvas', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out + '/desktop.png' });
  console.log('errors:', JSON.stringify(errs, null, 1));
  module.exports.page = p;
  if (!process.env.KEEP) await b.close();
})();
