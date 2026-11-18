// Run: node tests/bidir.test.js — bidirectional connections and folding opposite directions
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const base = [
  { '.type': 'object', '.name': 'lan', type: 'network', label: 'LAN', zone: 'lan', address: ['192.168.1.0/24'] },
  { '.type': 'object', '.name': 'dmz', type: 'network', label: 'DMZ', zone: 'dmz', address: ['10.0.0.0/24'] },
  { '.type': 'object', '.name': 'inet', type: 'zone', label: 'Internet', zone: 'wan' },
];

// one connection, both directions, own services, masq only forward
let m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'c1', src: 'lan', dest: 'dmz', service: ['b_https'], bidir: '1', service_rev: ['b_dns'], action: 'ACCEPT', nat: 'masq' },
]));
assert.strictEqual(m.connections.c1.bidir, true);
assert.deepStrictEqual(m.connections.c1.service_rev, ['b_dns']);
let g = M.generate(m);
assert.deepStrictEqual(g.problems, []);
const rules = g.sections.filter(s => s['.type'] == 'rule');
assert.deepStrictEqual(rules.map(r => [r.src, r.dest, r.proto]), [['lan', 'dmz', 'tcp'], ['dmz', 'lan', 'tcp udp']]);
assert.strictEqual(rules[1].name, 'DMZ → LAN');
assert.deepStrictEqual(rules[1].src_ip, ['10.0.0.0/24']);
assert.strictEqual(g.sections.filter(s => s['.type'] == 'nat').length, 1);
assert.strictEqual(new Set(g.sections.map(s => s['.name'])).size, g.sections.length);

// round trip; service_rev dropped when not bidirectional
let sec = M.toSections(m).find(s => s['.name'] == 'c1');
assert.strictEqual(sec.bidir, '1'); assert.deepStrictEqual(sec.service_rev, ['b_dns']);
m.connections.c1.bidir = false;
sec = M.toSections(m).find(s => s['.name'] == 'c1');
assert.ok(!('bidir' in sec) && !('service_rev' in sec));
assert.strictEqual(M.generate(m).sections.filter(s => s['.type'] == 'rule').length, 1);

// folding: B->A into A->B (with masq), C between with other action blocks
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_dns'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'x', src: 'lan', dest: 'inet', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c', src: 'dmz', dest: 'lan', service: ['b_ssh'], action: 'ACCEPT' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b', 'c']), 1);
assert.ok(!m.connections.b && m.connections.c);
assert.strictEqual(m.connections.a.bidir, true);
assert.deepStrictEqual(m.connections.a.service_rev, ['b_dns']);

// NAT on both sides or different action: not folded
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_dns'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'c', src: 'dmz', dest: 'lan', service: ['b_ssh'], action: 'DROP' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b', 'c']), 0);

// the one with NAT is kept even if it comes later
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_dns'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b']), 1);
assert.ok(m.connections.a && !m.connections.b);

console.log('bidir tests passed');
