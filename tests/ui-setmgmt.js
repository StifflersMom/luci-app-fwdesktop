// IP set management: create (with validation), rename (references follow), delete, save & apply.
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
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) }).first();
  const setRow = n => p.locator('div[data-tab="ipsets"] .fwd-table tr', { hasText: n });
  await p.click('li[data-tab="ipsets"] a'); await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/sets-tab.png' });

  // create with an invalid entry -> error, then fix
  await p.click('button:has-text("+ New IP set")'); await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('office');
  await row('Entries').locator('textarea').fill('192.0.2.0/24\nnot-an-ip\n198.51.100.7');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(300);
  const err = await p.locator('.modal .fwd-problem').innerText().catch(() => '');
  await p.screenshot({ path: out + '/sets-edit.png' });
  await row('Entries').locator('textarea').fill('192.0.2.0/24\n# comment\n198.51.100.7');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(400);

  // rename blocklist -> badhosts
  await setRow('blocklist').locator('button:has-text("Edit")').click();
  await p.waitForSelector('.modal .fwd-form');
  await row('Name').locator('input').fill('badhosts');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(400);

  // delete kids: used by an imported manual rule? then blocked; otherwise deletes object + connection
  await setRow('kids').locator('button:has-text("Delete")').click();
  await p.waitForSelector('.modal'); await p.waitForTimeout(200);
  const delMsg = await p.locator('.modal').innerText();
  const neg = p.locator('.modal button.cbi-button-negative:has-text("Delete")');
  if (await neg.count()) await neg.click(); else await p.click('.modal button:has-text("Close")');
  await p.waitForTimeout(400);
  await p.screenshot({ path: out + '/sets-after.png' });

  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(9000);
  console.log('validation error:', JSON.stringify(err));
  console.log('delete dialog:', JSON.stringify(delMsg.slice(0, 200)));
  console.log('errors:', JSON.stringify(errs)); await b.close();
})();
