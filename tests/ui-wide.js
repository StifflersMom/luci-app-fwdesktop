// Wide layout + fullscreen check at 2560px, dark scheme.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 2560, height: 1300 }, colorScheme: 'dark' });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(800);
  const w = await p.evaluate(() => document.querySelector('.fwd-canvas').getBoundingClientRect().width);
  await p.screenshot({ path: out + '/wide.png' });
  await p.click('button:has-text("Wide layout")'); await p.waitForTimeout(400);
  const n = await p.evaluate(() => document.querySelector('.fwd-canvas').getBoundingClientRect().width);
  await p.click('button:has-text("Wide layout")'); await p.waitForTimeout(200);
  await p.click('button:has-text("Fullscreen")'); await p.waitForTimeout(800);
  const fs = await p.evaluate(() => [!!document.fullscreenElement, document.querySelector('.fwd-canvas').getBoundingClientRect().height]);
  await p.screenshot({ path: out + '/fullscreen.png' });
  // dialogs must be visible while fullscreen
  await p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: 'LAN' }) }).locator('.fwd-box').dblclick();
  await p.waitForSelector('.modal .fwd-form', { state: 'visible', timeout: 5000 });
  await p.waitForTimeout(500); await p.screenshot({ path: out + '/fullscreen-dialog.png' });
  await p.click('.modal button:has-text("Cancel")');
  await p.click('button:has-text("Exit fullscreen")'); await p.waitForTimeout(300);
  fs.push(await p.evaluate(() => [!!document.fullscreenElement, document.body.classList.contains('fwd-max')]));
  console.log('canvas width wide/narrow:', w, n, 'fullscreen:', fs, 'errors:', JSON.stringify(errs)); await b.close();
})();
