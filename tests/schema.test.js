// Run: node tests/schema.test.js
// Generated sections must respect fw4's scalar/list option types
// (redirect and nat sections take single addresses and ports).
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const SCALAR = {
  redirect: [ 'src', 'dest', 'src_ip', 'src_dip', 'src_port', 'src_dport', 'dest_ip', 'dest_port', 'ipset', 'family', 'target', 'name' ],
  nat: [ 'src', 'src_ip', 'src_port', 'dest_ip', 'dest_port', 'family', 'target', 'name' ],
  rule: [ 'src', 'dest', 'ipset', 'family', 'target', 'name', 'limit' ]
};

const m = M.fromSections([
  { '.type': 'object', '.name': 'inet', type: 'zone', zone: 'wan', label: 'Internet' },
  { '.type': 'object', '.name': 'cable', type: 'zone', zone: 'wan_cable', label: 'Cable' },
  { '.type': 'object', '.name': 'wans', type: 'group', member: ['inet', 'cable'], label: 'All WANs' },
  { '.type': 'object', '.name': 'lanz', type: 'zone', zone: 'lan', label: 'LAN' },
  { '.type': 'object', '.name': 'trusted', type: 'network', zone: 'wan', address: ['193.175.20.0/24', '147.135.176.188', '2001:db8::1'], label: 'Trusted' },
  { '.type': 'object', '.name': 'pcs', type: 'network', zone: 'lan', address: ['10.11.1.10', '10.11.1.11'], label: 'PCs' },
  { '.type': 'object', '.name': 'srv', type: 'host', zone: 'lan', address: ['10.11.1.1'], label: 'Server' },
  { '.type': 'object', '.name': 'v6only', type: 'host', zone: 'wan', address: ['2001:db8::2'], label: 'v6' },
  { '.type': 'connection', '.name': 'pf', src: 'trusted', dest: 'srv', service: ['b_ssh', 'b_https'], action: 'ACCEPT', nat: 'dnat', ext_port: '2222 8443' },
  { '.type': 'connection', '.name': 'pf2', src: 'wans', dest: 'srv', service: ['b_rdp'], action: 'ACCEPT', nat: 'dnat' },
  { '.type': 'connection', '.name': 'pf6', src: 'v6only', dest: 'srv', service: ['b_ssh'], action: 'ACCEPT', nat: 'dnat' },
  { '.type': 'connection', '.name': 'mq', src: 'pcs', dest: 'inet', service: ['b_any'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'mq2', src: 'lanz', dest: 'inet', service: ['b_any'], action: 'ACCEPT', nat: 'masq' },
]);
const g = M.generate(m);
for (const s of g.sections)
  for (const k of SCALAR[s['.type']] || [])
    assert.ok(!Array.isArray(s[k]), s['.name'] + ': option ' + k + ' must not be a list');

const red = g.sections.filter(s => s['.name'].startsWith('fwd_pf_'));
assert.strictEqual(red.length, 4);                 // 2 ports x 2 IPv4 sources (IPv6 source skipped)
assert.ok(red.every(r => typeof r.src_ip == 'string' && r.src_ip.indexOf(':') < 0));
assert.ok(red.some(r => r.src_ip == '147.135.176.188' && r.src_dport == '2222' && r.dest_port == '22'));
const pf2 = g.sections.filter(s => s['.name'].startsWith('fwd_pf2_'));
assert.deepStrictEqual(pf2.map(r => r.src).sort(), ['wan', 'wan_cable']);  // one redirect per WAN zone
assert.ok(g.problems.some(p => p.conn == 'pf6'));
const nat = g.sections.filter(s => s['.name'].startsWith('fwd_mq_') && s['.type'] == 'nat');
assert.deepStrictEqual(nat.map(n => n.src_ip).sort(), ['10.11.1.10', '10.11.1.11']);
const nat2 = g.sections.filter(s => s['.name'].startsWith('fwd_mq2_') && s['.type'] == 'nat');
assert.strictEqual(nat2.length, 1); assert.strictEqual(nat2[0].src_ip, undefined);
console.log('SCHEMA OK');
