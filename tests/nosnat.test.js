// Run: node tests/nosnat.test.js — "prevent source rewrite" (fw4 nat rule, target ACCEPT)
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const base = [
  { '.type': 'object', '.name': 'lan', type: 'network', label: 'LAN', zone: 'lan', address: ['192.168.1.0/24'] },
  { '.type': 'object', '.name': 'vpn', type: 'network', label: 'VPN site', zone: 'vpn', address: ['10.8.0.0/24', 'fd00::/64'] },
  { '.type': 'object', '.name': 'router', type: 'router', label: 'Router' },
];
const g = M.generate(M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'c1', src: 'lan', dest: 'vpn', service: ['b_any'], bidir: '1', action: 'ACCEPT', nat: 'nosnat' },
])));
assert.deepStrictEqual(g.problems, []);
const nat = g.sections.filter(s => s['.type'] == 'nat');
assert.strictEqual(nat.length, 1); // only A → B, IPv6 address skipped
assert.deepStrictEqual(nat[0], { '.type': 'nat', '.name': nat[0]['.name'], name: 'LAN → VPN site (no NAT)', family: 'ipv4',
  src: 'vpn', src_ip: '192.168.1.0/24', dest_ip: '10.8.0.0/24', proto: 'all', target: 'ACCEPT' });
assert.strictEqual(g.sections.filter(s => s['.type'] == 'rule').length, 2);

// round trip keeps the value
const m = M.fromSections(base.concat([{ '.type': 'connection', '.name': 'c1', src: 'lan', dest: 'vpn', service: ['b_any'], action: 'ACCEPT', nat: 'nosnat' }]));
assert.strictEqual(M.fromSections(M.toSections(m)).connections.c1.nat, 'nosnat');

// not for the router itself, not for IPv6 only
const bad = M.generate(M.fromSections(base.concat([
  { '.type': 'connection', '.name': 'r', src: 'lan', dest: 'router', service: ['b_any'], action: 'ACCEPT', nat: 'nosnat' },
  { '.type': 'connection', '.name': 'v6', src: 'lan', dest: 'vpn', service: ['b_any'], action: 'ACCEPT', nat: 'nosnat', family: 'ipv6' },
])));
assert.ok(bad.problems.some(p => p.conn == 'r'));
assert.ok(bad.problems.some(p => p.conn == 'v6'));
console.log('ALL OK');

// a later "no source rewrite" rule still comes before an earlier masquerade rule
{
  const g2 = M.generate(M.fromSections(base.concat([
    { '.type': 'object', '.name': 'inet', type: 'zone', label: 'Internet', zone: 'wan' },
    { '.type': 'object', '.name': 'peer', type: 'network', label: 'Peer', zone: 'wan', address: ['203.0.113.0/24'] },
    { '.type': 'connection', '.name': 'm', src: 'lan', dest: 'inet', service: ['b_any'], action: 'ACCEPT', nat: 'masq' },
    { '.type': 'connection', '.name': 'x', src: 'lan', dest: 'peer', service: ['b_any'], action: 'ACCEPT', nat: 'nosnat' },
  ])));
  const nats = g2.sections.filter(s => s['.type'] == 'nat').map(s => s.target);
  assert.deepStrictEqual(nats, ['ACCEPT', 'MASQUERADE']);
  console.log('ORDER OK');
}
