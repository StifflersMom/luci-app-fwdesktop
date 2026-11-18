// End-to-end flow: create host, connect objects, save & apply, check fw4.
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() == 'error') errs.push(m.text()); });
  await p.goto(BASE + '/cgi-bin/luci/');
  await p.fill('input[name=luci_password]', 'test1234');
  await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle');
  errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop');
  await p.waitForSelector('.fwd-node');
  await p.waitForTimeout(500);

  const node = label => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: label }) });
  const connect = async (a, z) => {
    const h = await node(a).locator('.fwd-handle').boundingBox();
    const t = await node(z).locator('.fwd-box').boundingBox();
    await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await p.mouse.down();
    await p.mouse.move(t.x + 40, t.y + 20, { steps: 8 });
    await p.mouse.move(t.x + 50, t.y + 25, { steps: 2 });
    await p.mouse.up();
    await p.waitForSelector('.modal .fwd-form');
  };
  const pickService = async label => {
    const svcRow = p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: /^Services$/ }) });
    await svcRow.locator('.cbi-dropdown').click();
    await svcRow.locator(`.cbi-dropdown li[data-value]:has-text("${label}")`).first().click();
    await p.keyboard.press('Escape').catch(()=>{});
    await p.click('.modal h4, .modal .fwd-form h5');
  };

  // 1. new host "NAS"
  await p.click('button.fwd-add.fwd-type-host');
  await p.waitForSelector('.modal .fwd-form');
  await p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: 'Name' }) }).locator('input').fill('NAS');
  await p.click('.modal .cbi-dynlist .cbi-dropdown');
  const addr = p.locator('.modal .cbi-dynlist .create-item-input').first();
  await addr.fill('192.168.1.10'); await addr.press('Enter');
  await p.screenshot({ path: out + '/dlg-host.png' });
  await p.click('.modal button:has-text("Apply")');
  await p.waitForTimeout(300);

  // move NAS somewhere free
  const nb = await node('NAS').locator('.fwd-box').boundingBox();
  await p.mouse.move(nb.x + 80, nb.y + 30); await p.mouse.down();
  await p.mouse.move(nb.x + 80 - 250, nb.y + 30 + 200, { steps: 10 }); await p.mouse.up();

  // 2. LAN -> Internet (web), default masq
  await connect('LAN', 'Internet');
  await pickService('HTTPS (TCP 443)'); await pickService('DNS (TCP+UDP 53)');
  await p.screenshot({ path: out + '/dlg-conn.png' });
  await p.click('.modal button:has-text("Apply")');
  await p.waitForTimeout(300);

  // 3. Internet -> NAS port forward, HTTPS
  await connect('Internet', 'NAS');
  await pickService('HTTPS (TCP 443)');
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) });
  await row('NAT').locator('select').selectOption('dnat');
  await row('Public ports').locator('input').fill('8443');
  await p.waitForTimeout(200);
  await p.screenshot({ path: out + '/dlg-dnat.png' });
  await p.click('.modal button:has-text("Apply")');
  await p.waitForTimeout(300);

  // 4. LAN -> router (SSH) with log
  await connect('LAN', 'This router');
  await pickService('SSH (TCP 22)');
  await p.click('.modal button:has-text("Apply")');
  await p.waitForTimeout(300);
  await p.screenshot({ path: out + '/desktop-conns.png' });

  // 5. Save & Apply
  await p.click('.cbi-page-actions button.cbi-button-apply, .cbi-page-actions .cbi-button-apply');
  await p.waitForTimeout(8000);
  await p.screenshot({ path: out + '/after-apply.png' });
  await p.click('.cbi-tab-disabled[data-tab="preview"], li[data-tab="preview"] a').catch(()=>{});
  await p.waitForTimeout(500);
  await p.screenshot({ path: out + '/preview.png', fullPage: true });
  console.log('errors:', JSON.stringify(errs, null, 1));
  await b.close();
})();
