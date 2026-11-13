// One line per direction: hover card + bundle dialog.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1800, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-edge'); await p.waitForTimeout(800);
  const edges = await p.locator('.fwd-edge').count();
  await p.screenshot({ path: out + '/bundle-desktop.png' });
  // hover the busiest line (Internet -> router)
  const busiest = p.locator('.fwd-edge').filter({ has: p.locator('text=/× ·/') }).first();
  await busiest.locator('.fwd-badge').hover();
  await p.waitForSelector('.fwd-tooltip.visible', { timeout: 5000 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/bundle-tooltip.png' });
  // click opens the bundle dialog
  await busiest.locator('.fwd-badge').click();
  await p.waitForSelector('.modal table', { state: 'visible' }); await p.waitForTimeout(400);
  await p.screenshot({ path: out + '/bundle-dialog.png' });
  const rows = await p.locator('.modal table tr').count();
  // merge
  const mergeBtn = p.locator('.modal button:has-text("Merge")');
  const hasMerge = await mergeBtn.count();
  if (hasMerge) { await mergeBtn.click(); await p.waitForTimeout(800); await p.screenshot({ path: out + '/bundle-merged.png' }); }
  await p.keyboard.press('Escape').catch(()=>{});
  await p.click('.modal button:has-text("Close")').catch(()=>{});
  await p.waitForTimeout(300);
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000);
  await p.screenshot({ path: out + '/bundle-applied.png' });
  console.log('edges:', edges, 'dialog rows:', rows, 'merge button:', hasMerge, 'errors:', JSON.stringify(errs));
  await b.close();
})();
