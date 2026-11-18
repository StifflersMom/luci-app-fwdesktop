// Line = rule list between A and B, each rule with its own services and direction; masquerading preset.
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
    await p.waitForSelector('.modal .fwd-form, .modal .fwd-pair'); await p.waitForTimeout(300);
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

  // a drag onto an object with a line opens the rule list; new rule from there
  const newRule = async () => {
    if (!(await p.locator('.modal .fwd-form').count())) await p.click('.modal button:has-text("+ Add rule")');
    await p.waitForSelector('.modal .fwd-form');
  };
  const cancel = async () => { await p.click('.modal button:has-text("Cancel")'); await p.waitForTimeout(300); if (await p.locator('.modal button:has-text("Close")').count()) await p.click('.modal button:has-text("Close")'); await p.waitForTimeout(200); };

  // masquerading preset: private -> internet zone (wan has zone masq on), not between LAN hosts or from outside
  await connect('PCs', 'Internet'); await newRule();
  ok(await row('NAT').locator('select').inputValue() == 'masq', 'PCs → Internet preselects masquerading');
  await row('Direction').locator('select').selectOption('rev'); await p.waitForTimeout(200);
  ok(await row('NAT').locator('select').inputValue() == 'none', 'turning it into Internet → PCs drops the preset');
  await cancel();
  await connect('Server', 'Internet'); await newRule();
  ok(await row('NAT').locator('select').inputValue() == 'masq', 'Server → Internet preselects masquerading');
  await cancel();
  await connect('Trusted', 'Server');
  ok(await p.locator('.modal .fwd-pair-obj strong').first().innerText() == 'Trusted', 'existing line: rule list opens with A = drag start');
  await newRule();
  ok(await row('NAT').locator('select').inputValue() == 'none', 'public network → LAN host: no masquerading');
  await cancel();

  // new line Server -> PCs: rule editor first, then the rule list
  await connect('Server', 'PCs');
  ok(/New rule: Server — PCs/.test(await p.locator('.modal h4').innerText()), 'editor header names A and B');
  ok(await row('NAT').locator('select').inputValue() == 'none', 'LAN → LAN: no masquerading');
  await pick('Services', 'HTTPS');
  await row('Direction').locator('select').selectOption('both'); await p.waitForTimeout(200);
  const prev = await p.locator('.modal .fwd-preview').innerText();
  ok(/Server → PCs/.test(prev) && /PCs → Server/.test(prev), 'preview has rules for both directions');
  await p.screenshot({ path: path.join(out, 'rule-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForSelector('.modal .fwd-pair'); await p.waitForTimeout(300);
  ok(await p.locator('.modal .fwd-pair-obj strong').first().innerText() == 'Server', 'rule list opens after the first rule, A = Server');
  ok(await p.locator('.modal select.fwd-dir').first().inputValue() == 'both', 'first rule shows A ↔ B');

  // second rule DNS, B starts (A ← B)
  await p.click('.modal button:has-text("+ Add rule")'); await p.waitForSelector('.modal .fwd-form');
  await pick('Services', 'DNS');
  await row('Direction').locator('select').selectOption('rev');
  await p.click('.modal button:has-text("Apply")'); await p.waitForSelector('.modal .fwd-pair'); await p.waitForTimeout(300);
  ok(await p.locator('.modal select.fwd-dir').count() == 2, 'two rules listed');
  ok(await p.locator('.modal select.fwd-dir').nth(1).inputValue() == 'rev', 'DNS rule shows A ← B');
  await p.screenshot({ path: path.join(out, 'rule-list.png') });
  await p.locator('.modal select.fwd-dir').nth(1).selectOption('fwd'); await p.waitForTimeout(500);
  ok(await p.locator('.modal select.fwd-dir').nth(1).inputValue() == 'fwd', 'direction changed inline to A → B');
  await p.locator('.modal select.fwd-dir').nth(1).selectOption('rev'); await p.waitForTimeout(500);
  await p.click('.modal button:has-text("Close")'); await p.waitForTimeout(300);

  ok(await edges('srv', 'pcs').count() == 1, 'one line for Server/PCs');
  const line = edges('srv', 'pcs').locator('.fwd-line');
  ok(await line.getAttribute('marker-start') && await line.getAttribute('marker-end'), 'arrows on both ends');
  await p.screenshot({ path: path.join(out, 'rule-canvas.png') });

  // drag the other way: same list, now seen from PCs
  await connect('PCs', 'Server');
  ok(await p.locator('.modal .fwd-pair-obj strong').first().innerText() == 'PCs', 'A = PCs when dragged from PCs');
  ok(JSON.stringify(await p.locator('.modal select.fwd-dir').evaluateAll(l => l.map(x => x.value))) == '["both","fwd"]', 'directions seen from PCs');
  await p.click('.modal button:has-text("Close")'); await p.waitForTimeout(300);

  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000);
  const conns = ssh("uci show fwdesktop | grep -c bidir; uci show fwdesktop | grep -c service_rev");
  ok(conns == '1\n0', 'stored: one ↔ rule, no service_rev ' + JSON.stringify(conns));
  const fw = ssh("uci show firewall | grep -c \"name='Server → PCs'\"; uci show firewall | grep -c \"name='PCs → Server'\"; fw4 check");
  ok(/^1\n2\n[\s\S]*Ruleset passes/.test(fw), 'firewall: HTTPS Server → PCs, HTTPS + DNS PCs → Server ' + JSON.stringify(fw));

  ssh('cp /tmp/fwdesktop.bak /etc/config/fwdesktop; cp /tmp/firewall.bak /etc/config/firewall; fw4 reload >/dev/null 2>&1');
  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
