// Run: node tests/bidir.test.js — bidirectional connections and folding opposite directions
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const base = [
  { '.type': 'object', '.name': 'lan', type: 'network', label: 'LAN', zone: 'lan', address: ['192.168.1.0/24'] },
  { '.type': 'object', '.name': 'dmz', type: 'network', label: 'DMZ', zone: 'dmz', address: ['10.0.0.0/24'] },
  { '.type': 'object', '.name': 'inet', type: 'zone', label: 'Internet', zone: 'wan' },
];

// one rule, both directions with the same services, masq only forward
let m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'c1', src: 'lan', dest: 'dmz', service: ['b_https'], bidir: '1', action: 'ACCEPT', nat: 'masq' },
]));
assert.strictEqual(m.connections.c1.bidir, true);
let g = M.generate(m);
assert.deepStrictEqual(g.problems, []);
const rules = g.sections.filter(s => s['.type'] == 'rule');
assert.deepStrictEqual(rules.map(r => [r.src, r.dest, r.proto]), [['lan', 'dmz', 'tcp'], ['dmz', 'lan', 'tcp']]);
assert.strictEqual(rules[1].name, 'DMZ → LAN');
assert.deepStrictEqual(rules[1].src_ip, ['10.0.0.0/24']);
assert.strictEqual(g.sections.filter(s => s['.type'] == 'nat').length, 1);
assert.strictEqual(new Set(g.sections.map(s => s['.name'])).size, g.sections.length);

// round trip
let sec = M.toSections(m).find(s => s['.name'] == 'c1');
assert.strictEqual(sec.bidir, '1'); assert.ok(!('service_rev' in sec));
m.connections.c1.bidir = false;
sec = M.toSections(m).find(s => s['.name'] == 'c1');
assert.ok(!('bidir' in sec));
assert.strictEqual(M.generate(m).sections.filter(s => s['.type'] == 'rule').length, 1);

// older test builds: other services back become an own rule
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'c1', src: 'lan', dest: 'dmz', service: ['b_https'], bidir: '1', service_rev: ['b_dns'], action: 'ACCEPT', nat: 'masq' },
]));
const ids = Object.keys(m.connections);
assert.strictEqual(ids.length, 2);
assert.strictEqual(m.connections.c1.bidir, false);
const r2 = m.connections[ids.find(i => i != 'c1')];
assert.deepStrictEqual([r2.src, r2.dest, r2.service, r2.nat], ['dmz', 'lan', ['b_dns'], 'none']);

// folding: opposite rule with the same services becomes ↔; other services or action in between block
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_https'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'd', src: 'dmz', dest: 'lan', service: ['b_dns'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'x', src: 'lan', dest: 'inet', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c', src: 'dmz', dest: 'lan', service: ['b_https'], action: 'ACCEPT' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b', 'c', 'd']), 1);
assert.ok(!m.connections.b && m.connections.c && m.connections.d);
assert.strictEqual(m.connections.a.bidir, true);

// NAT on both sides or different action: not folded
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_dns'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'c', src: 'dmz', dest: 'lan', service: ['b_ssh'], action: 'DROP' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b', 'c']), 0);

// the one with NAT is kept even if it comes later
m = M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'b', src: 'dmz', dest: 'lan', service: ['b_https'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'a', src: 'lan', dest: 'dmz', service: ['b_https'], action: 'ACCEPT', nat: 'masq' },
]));
assert.strictEqual(M.mergeOpposite(m, ['a', 'b']), 1);
assert.ok(m.connections.a && !m.connections.b);

console.log('bidir tests passed');
