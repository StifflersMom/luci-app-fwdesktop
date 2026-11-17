// "Reset affected connections": enable setting, change a rule, Save & Apply, check conntrack + log.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const out = process.argv[2] || '.';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const sshArgs = ['-i', path.join(__dirname, '../testvm/ssh_key'), '-p', '2223', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=error', 'root@127.0.0.1'];
const ssh = cmd => execFileSync('ssh', sshArgs.concat([cmd])).toString().trim();
(async () => {
  // a long-lived TCP connection to port 22 (from 10.0.2.2, lan zone)
  const hold = spawn('ssh', sshArgs.concat(['sleep 90']), { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2000));
  const ctBefore = ssh("conntrack -L -p tcp --dport 22 2>/dev/null | grep -c ESTABLISHED");
  ssh('logread -e fwdesktop >/dev/null; true');

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(BASE + '/cgi-bin/luci/'); await p.fill('input[name=luci_password]', 'test1234'); await p.click('button.cbi-button-positive');
  await p.waitForLoadState('networkidle'); errs.length = 0;
  const open = async () => { await p.goto(BASE + '/cgi-bin/luci/admin/network/fwdesktop'); await p.waitForSelector('.fwd-node'); await p.waitForTimeout(500); };
  const row = l => p.locator('.modal .fwd-row', { has: p.locator('label', { hasText: l }) }).first();
  const node = l => p.locator('.fwd-node', { has: p.locator('.fwd-title', { hasText: l }) });

  await open();
  await p.click('li[data-tab="settings"] a'); await p.waitForTimeout(200);
  await p.check('input[name="fwd-ct"][value="targeted"]'); await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(out, 'ct-settings.png') });
  await p.click('li[data-tab="desktop"] a'); await p.waitForTimeout(200);

  // new connection LAN -> This router, SSH, allow + log (changes the rule set for tcp/22)
  const h = await node('LAN').locator('.fwd-handle').boundingBox();
  const t = await node('This router').locator('.fwd-box').boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await p.mouse.down();
  await p.mouse.move(t.x + 40, t.y + 20, { steps: 8 }); await p.mouse.move(t.x + 50, t.y + 25, { steps: 2 }); await p.mouse.up();
  await p.waitForSelector('.modal .fwd-form');
  const svc = row('Services'); await svc.locator('.cbi-dropdown').click();
  await svc.locator('.cbi-dropdown li[data-value="b_ssh"]').first().click();
  await p.keyboard.press('Escape').catch(()=>{}); await p.click('.modal h4');
  await row('Log matches').locator('input[type=checkbox]').check();
  await row('Name').locator('input').fill('ct-test');
  await p.click('.modal button:has-text("Apply")'); await p.waitForTimeout(800);

  await p.click('.cbi-page-actions .cbi-button-apply'); await p.waitForTimeout(12000);
  const log = ssh("logread -e fwdesktop | tail -3");
  const setting = ssh("uci -q get fwdesktop.global.ct_reset");
  console.log('established tcp/22 before:', ctBefore, '| setting:', setting);
  console.log('log:', JSON.stringify(log));
  console.log('fw4:', ssh('fw4 check 2>&1 | tail -1'), '| pending:', ssh('uci changes | wc -l'));
  console.log('errors:', JSON.stringify(errs)); await b.close(); hold.kill();
})();
