// Import flow: open import dialog, import all convertible, save & apply.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500);
  await p.click('button:has-text("Import rules")');
  await p.waitForSelector('.modal table'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/import-dialog.png' });
  await p.click('.modal button:has-text("Import selected")'); await p.waitForTimeout(800);
  await p.screenshot({ path: out + '/import-desktop.png' });
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000);
  await p.screenshot({ path: out + '/import-applied.png' });
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
