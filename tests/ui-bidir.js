// One line per object pair, "both ways" connections, merging opposite directions, masquerading preset.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd + '; true']).toString().trim();
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  ssh('cp /etc/config/fwdesktop /tmp/fwdesktop.bak; cp /etc/config/firewall /tmp/firewall.bak; uci set fwdesktop.trusted.y=700; uci commit fwdesktop');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => { if (!errs.length) console.log('STACK', e.stack); errs.push(String(e)); });
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500);

  const node = label => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: new RegExp('^' + label + '$') }) });
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const connect = async (a, z) => {
    const h = await node(a).locator('.fwd-handle').boundingBox();
    const t = await node(z).locator('.fwd-box').boundingBox();
    await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await p.mouse.down();
    await p.mouse.move(t.x + 40, t.y + 20, { steps: 8 }); await p.mouse.move(t.x + 50, t.y + 25, { steps: 2 }); await p.mouse.up();
    await p.waitForSelector('.modal .fwd-form');
  };
  const pick = async (rowLabel, label) => {
    const r = row(rowLabel);
    await r.locator('.cbi-dropdown').click();
    await r.locator(`.cbi-dropdown li[data-value]:has-text("${label}")`).first().click();
    await p.keyboard.press('Escape').catch(() => {});
    await p.click('.modal .fwd-form h5');
  };
  const chosen = async rowLabel => (await row(rowLabel).locator('.cbi-dropdown > ul > li[selected]').allInnerTexts()).map(t => t.trim());
  const edges = (a, z) => p.locator(`.fwd-edge[data-bundle="${[a, z].sort().join('|')}"]`);

  // masquerading preset: private host -> internet zone (wan has zone masq on), not between two LAN hosts
  await connect('PCs', 'Internet');
  ok(await row('NAT').locator('select').inputValue() == 'masq', 'PCs → Internet preselects masquerading');
  await p.click('.modal button:has-text("Cancel")');
  await connect('Server', 'Internet');
  ok(await row('NAT').locator('select').inputValue() == 'masq', 'Server → Internet preselects masquerading');
  await p.click('.modal button:has-text("Cancel")');
  await connect('Trusted', 'Server');
  ok(await row('NAT').locator('select').inputValue() == 'none', 'public network → LAN host: no masquerading');
  await p.click('.modal button:has-text("Cancel")');

  // both ways: Server -> PCs HTTPS, back SSH
  await connect('Server', 'PCs');
  ok(await row('NAT').locator('select').inputValue() == 'none', 'LAN → LAN: no masquerading');
  ok(!(await row('Services back').isVisible()), 'services back hidden for one way');
  await pick('Services', 'HTTPS');
  await row('Direction').locator('select').selectOption('1');
  await p.waitForTimeout(200);
  ok(await row('Services back').isVisible(), 'services back shown for both ways');
  ok(JSON.stringify(await chosen('Services back')).includes('HTTPS'), 'services back prefilled with HTTPS');
  await row('Services back').locator('.cbi-dropdown').click();
  await row('Services back').locator('.cbi-dropdown li[data-value][selected]:has-text("HTTPS")').first().click();
  await row('Services back').locator('.cbi-dropdown li[data-value]:has-text("SSH")').first().click();
  await p.keyboard.press('Escape').catch(() => {});
  await p.click('.modal .fwd-form h5');
  const prev = await p.locator('.modal .fwd-preview').innerText();
  ok(/option src_ip '10\.0\.2\.10'[\s\S]*option dest_port '22'/.test(prev) || /PCs → Server/.test(prev), 'preview has the reverse rule');
  await p.screenshot({ path: path.join(out, 'bidir-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(500);

  ok(await edges('srv', 'pcs').count() == 1, 'one line for Server/PCs');
  const line = edges('srv', 'pcs').locator('.fwd-line');
  ok(await line.getAttribute('marker-start') && await line.getAttribute('marker-end'), 'arrows on both ends');

  // separate PCs -> Server connection shares the same line
  await connect('PCs', 'Server');
  await pick('Services', 'DNS');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(500);
  ok(await edges('srv', 'pcs').count() == 1, 'still one line with a second connection');
  await p.screenshot({ path: path.join(out, 'bidir-canvas.png') });

  // dialog lists both; merge folds them into one connection
  await edges('srv', 'pcs').locator('.fwd-badge').click(); await p.waitForSelector('.modal table');
  ok(await p.locator('.modal tr.tr').count() == 3, 'dialog lists both connections');
  ok(await p.locator('.modal button:has-text("+ PCs → Server")').count() == 1, 'add button for the other direction');
  await p.screenshot({ path: path.join(out, 'bidir-bundle.png') });
  await p.click('.modal button:has-text("Merge")'); await p.waitForTimeout(800);
  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000);
  const conns = ssh("uci show fwdesktop | grep -E \"src='(srv|pcs)'\" | grep -v mqtest | wc -l; uci show fwdesktop | grep -E 'service_rev|bidir'");
  ok(/^1\n/.test(conns) && /bidir='1'/.test(conns) && /b_ssh/.test(conns) && /b_dns/.test(conns), 'merged into one both-ways connection');

  const fw = ssh("uci show firewall | grep -A12 \"name='Server → PCs'\" | grep -E 'src_ip|dest_port' | head -4; uci show firewall | grep -c \"name='PCs → Server'\"; fw4 check");
  ok(/Ruleset passes/.test(fw) && /\n[1-9]/.test(fw), 'firewall applied with rules for both directions');

  ssh('cp /tmp/fwdesktop.bak /etc/config/fwdesktop; cp /tmp/firewall.bak /etc/config/firewall; fw4 reload >/dev/null 2>&1');
  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
