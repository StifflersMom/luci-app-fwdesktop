// Run: node tests/ipset.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const m = M.fromSections([
  { '.type': 'object', '.name': 'router', type: 'router', label: 'Router' },
  { '.type': 'object', '.name': 'inet', type: 'zone', zone: 'wan', label: 'Internet' },
  { '.type': 'object', '.name': 'lan', type: 'zone', zone: 'lan', label: 'LAN' },
  { '.type': 'object', '.name': 'bad', type: 'ipset', zone: 'wan', ipset: 'blocklist', label: 'Blocklist' },
  { '.type': 'object', '.name': 'kids', type: 'ipset', zone: 'lan', ipset: 'kids', label: 'Kids' },
  { '.type': 'object', '.name': 'nas', type: 'host', zone: 'lan', address: ['192.168.1.10'], label: 'NAS' },
  { '.type': 'object', '.name': 'grp', type: 'group', member: ['nas', 'kids'], label: 'Mixed' },
  { '.type': 'connection', '.name': 'c1', src: 'bad', dest: 'router', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c2', src: 'kids', dest: 'inet', service: ['b_https'], action: 'REJECT' },
  { '.type': 'connection', '.name': 'c3', src: 'bad', dest: 'nas', service: ['b_https'], action: 'ACCEPT', nat: 'dnat', ext_port: '8443' },
  { '.type': 'connection', '.name': 'c4', src: 'kids', dest: 'bad', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c5', src: 'grp', dest: 'inet', service: ['b_ssh'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'c6', src: 'kids', dest: 'inet', service: ['b_any'], action: 'ACCEPT', nat: 'masq' },
]);
const g = M.generate(m);
const by = n => g.sections.find(s => s['.name'] == n);
assert.strictEqual(by('fwd_c1_r0').ipset, 'blocklist src');
assert.strictEqual(by('fwd_c1_r0').src, 'wan');
assert.strictEqual(by('fwd_c2_r0').ipset, 'kids src');
assert.strictEqual(by('fwd_c3_d0').ipset, 'blocklist src');
assert.ok(g.problems.some(p => p.conn == 'c4'));      // two sets
assert.ok(g.problems.some(p => p.conn == 'c6'));      // masq with set
const c5 = g.sections.filter(s => s['.name'].startsWith('fwd_c5_'));
assert.strictEqual(c5.length, 2);                     // host list + set as separate rules
assert.ok(c5.some(s => s.ipset == 'kids src') && c5.some(s => s.src_ip && s.src_ip[0] == '192.168.1.10'));

// round trip keeps the set name
assert.strictEqual(M.fromSections(M.toSections(m)).objects.bad.ipset, 'blocklist');

// import
const fw = [
  { '.type': 'zone', '.name': 'z1', name: 'lan' }, { '.type': 'zone', '.name': 'z2', name: 'wan' },
  { '.type': 'ipset', '.name': 's1', name: 'blocklist', match: ['src_net'] },
  { '.type': 'ipset', '.name': 's2', name: 'dsts', match: ['dest_ip'] },
  { '.type': 'rule', '.name': 'r1', name: 'Drop bad', src: 'wan', ipset: 'blocklist', target: 'DROP', proto: 'all' },
  { '.type': 'rule', '.name': 'r2', name: 'Block dsts', src: 'lan', dest: 'wan', ipset: 'dsts', target: 'REJECT', proto: 'all' },
  { '.type': 'rule', '.name': 'r3', name: 'Neg', src: 'wan', ipset: '!blocklist', target: 'DROP' },
  { '.type': 'rule', '.name': 'r4', name: 'Unknown', src: 'wan', ipset: 'nope', target: 'DROP' },
  { '.type': 'redirect', '.name': 'd1', name: 'PF', src: 'wan', ipset: 'blocklist src', src_dport: '2222', dest_ip: '192.168.1.10', dest_port: '22', proto: 'tcp', dest: 'lan' },
];
const m2 = M.fromSections([]);
const res = M.importFirewall(m2, fw, { zones: ['lan', 'wan'] });
for (const r of res) console.log(r.ok ? 'OK  ' : 'SKIP', r.name.padEnd(12), r.reason || '');
const ok = n => res.find(r => r.name == n).ok;
assert.ok(ok('Drop bad') && ok('Block dsts') && ok('PF'));
assert.ok(!ok('Neg') && !ok('Unknown'));
const g2 = M.generate(m2);
assert.strictEqual(g2.problems.length, 0);
const s = n => g2.sections.find(x => x.name && x.name.startsWith(n));
assert.strictEqual(s('Drop bad').ipset, 'blocklist src');
assert.strictEqual(s('Block dsts').ipset, 'dsts dest');
assert.strictEqual(s('Block dsts').dest, 'wan');
assert.strictEqual(s('PF').ipset, 'blocklist src');
console.log('IPSET OK');
