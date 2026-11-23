// "Prevent source rewrite" as NAT choice of a rule; ends up as fw4 nat rule with target ACCEPT.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const ssh = cmd => execFileSync('ssh', ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1', cmd + '; true']).toString().trim();
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  ssh('cp /etc/config/fwdesktop /tmp/fwdesktop.bak; cp /etc/config/firewall /tmp/firewall.bak');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500);

  const node = label => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: new RegExp('^' + label + '$') }) });
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: new RegExp('^' + l + '$') }) }).first();
  const h = await node('Server').locator('.fwd-handle').boundingBox();
  const t = await node('Internet').locator('.fwd-box').boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await p.mouse.down();
  await p.mouse.move(t.x + 40, t.y + 20, { steps: 8 }); await p.mouse.move(t.x + 50, t.y + 25, { steps: 2 }); await p.mouse.up();
  await p.waitForSelector('.modal .fwd-form, .modal .fwd-pair'); await p.waitForTimeout(300);
  if (!(await p.locator('.modal .fwd-form').count())) await p.click('.modal button:has-text("+ Add rule")');
  await p.waitForSelector('.modal .fwd-form');

  await row('Services').locator('.cbi-dropdown').click();
  await row('Services').locator('.cbi-dropdown li[data-value]:has-text("HTTPS")').first().click();
  await p.keyboard.press('Escape').catch(() => {}); await p.click('.modal .fwd-form h5');
  const nat = row('NAT').locator('select');
  ok(/Prevent source rewrite/.test(await nat.innerText()), 'NAT list offers "Prevent source rewrite"');
  await nat.selectOption('nosnat'); await p.waitForTimeout(300);
  const prev = await p.locator('.modal .fwd-preview').innerText();
  ok(/config nat/.test(prev) && /ACCEPT/.test(prev) && !/MASQUERADE/.test(prev), 'preview shows nat rule with ACCEPT');
  await p.screenshot({ path: path.join(out, 'nosnat-dialog.png') });
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(500);
  const listText = await p.locator('.modal').innerText().catch(() => '');
  ok(/No source rewrite/.test(listText), 'rule list shows "No source rewrite"');
  await p.screenshot({ path: path.join(out, 'nosnat-list.png') });
  if (await p.locator('.modal button:has-text("Close")').count()) await p.click('.modal button:has-text("Close")');
  await p.waitForTimeout(300);

  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000);
  ok(ssh("uci show fwdesktop | grep -c \"nat='nosnat'\"") == '1', 'stored nat=nosnat in fwdesktop');
  const fw = ssh("uci show firewall | grep -A9 '=nat' | grep -c \"target='ACCEPT'\"; fw4 check; fw4 print | sed -n '/chain srcnat_wan/,/}/p'");
  console.log(fw);
  ok(/^1\n[\s\S]*Ruleset passes[\s\S]*accept comment "!fw4: Server → Internet \(no NAT\)"[\s\S]*Masquerade IPv4 wan/.test(fw), 'fw4: accept before zone masquerade');

  ssh('cp /tmp/fwdesktop.bak /etc/config/fwdesktop; cp /tmp/firewall.bak /etc/config/firewall; fw4 reload >/dev/null 2>&1');
  ok(!errs.length, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
