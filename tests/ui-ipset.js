// IP set object: create via dialog, connect, import a set rule, save & apply.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500);
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) });
  const node = label => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: label }) });
  // new IP set object
  await p.click('button:has-text("+ IP set")'); await p.waitForSelector('.modal .fwd-form');
  await row('Zone').locator('select').selectOption('wan');
  await row('IP set').locator('select').selectOption('blocklist');
  await p.screenshot({ path: out + '/ipset-dialog.png' });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  // connect blocklist -> router, drop any
  const h = await node('blocklist').locator('.fwd-handle').boundingBox();
  const t = await node('This router').locator('.fwd-box').boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await p.mouse.down();
  await p.mouse.move(t.x + 40, t.y + 20, { steps: 8 }); await p.mouse.move(t.x + 50, t.y + 25, { steps: 2 }); await p.mouse.up();
  await p.waitForSelector('.modal .fwd-form');
  const svc = row('Services');
  await svc.locator('.cbi-dropdown').click();
  await svc.locator('.cbi-dropdown li[data-value="b_any"]').first().click();
  await p.keyboard.press('Escape').catch(()=>{});
  await p.click('.modal h4, .modal .fwd-form h5');
  await row('Action').locator('select').selectOption('DROP');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  // import the set rule
  await p.click('button:has-text("Import rules")'); await p.waitForSelector('.modal table'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/ipset-import.png' });
  await p.click('.modal button:has-text("Import selected")'); await p.waitForTimeout(600);
  await p.screenshot({ path: out + '/ipset-desktop.png' });
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000);
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
