// Run: node tests/import.test.js   (uses the stock OpenWrt 25.12 firewall config)
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const vals = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock-firewall.json'))).values;
const secs = Object.values(vals).sort((a, b) => a['.index'] - b['.index']);
// add some hand written extras
secs.push({ '.type': 'redirect', '.name': 'pf1', name: 'Plex', src: 'wan', src_dport: '40000', dest_ip: '192.168.1.10', dest_port: '32400', proto: 'tcp', target: 'DNAT' });
secs.push({ '.type': 'redirect', '.name': 'pf2', name: 'Web', src: 'wan', src_dport: '443', dest_ip: '192.168.1.20', proto: 'tcp' });
secs.push({ '.type': 'rule', '.name': 'r_any', name: 'Any zone', src: '*', dest: 'wan', target: 'DROP' });
secs.push({ '.type': 'rule', '.name': 'r_mark', name: 'Mark', src: 'lan', dest: 'wan', target: 'MARK', set_mark: '1' });
secs.push({ '.type': 'rule', '.name': 'r_blk', name: 'Block cam', src: 'lan', src_ip: ['192.168.1.50'], dest: 'wan', proto: 'all', target: 'REJECT', enabled: '0' });
secs.push({ '.type': 'rule', '.name': 'fwd_x_r0', name: 'ours', src: 'lan', dest: 'wan' });

const zones = secs.filter(s => s['.type'] == 'zone').map(s => s.name);
const model = M.fromSections([ { '.type': 'object', '.name': 'zone_lan', type: 'zone', zone: 'lan', label: 'LAN' } ]);
const res = M.importFirewall(model, secs, { zones, zoneForAddress: a => a.startsWith('192.168.1.') ? 'lan' : null });
for (const r of res) console.log(r.ok ? 'OK  ' : 'SKIP', r.type.padEnd(8), r.name.padEnd(24), r.reason || '');

const byName = n => res.find(r => r.name == n);
assert.ok(!res.some(r => r.sid == 'fwd_x_r0'));
assert.ok(byName('Allow-DHCP-Renew').ok);
assert.ok(byName('Allow-Ping').ok);
assert.ok(byName('Allow-ICMPv6-Input').ok);      // limit passed through
assert.ok(byName('Plex').ok && byName('Web').ok);
assert.ok(!byName('Any zone').ok && !byName('Mark').ok);
assert.ok(byName('Block cam').ok);
assert.ok(Object.values(model.objects).filter(o => o.type == 'zone' && o.zone == 'lan').length == 1); // reused

// regenerate and compare semantics of a few
const g = M.generate(model);
console.log('problems', g.problems);
assert.strictEqual(g.problems.length, 0);
const gen = n => g.sections.filter(s => s.name && s.name.startsWith(n));
const ping = gen('Allow-Ping')[0];
assert.strictEqual(ping.src, 'wan'); assert.strictEqual(ping.dest, undefined); assert.strictEqual(ping.proto, 'icmp'); assert.deepStrictEqual(ping.icmp_type, ['echo-request']); assert.strictEqual(ping.family, 'ipv4');
const icmp6 = gen('Allow-ICMPv6-Input')[0];
assert.strictEqual(icmp6.proto, 'icmpv6'); assert.strictEqual(icmp6.limit, '1000/sec'); assert.strictEqual(icmp6.family, 'ipv6');
const plex = gen('Plex')[0];
assert.strictEqual(plex['.type'], 'redirect'); assert.strictEqual(plex.src_dport, '40000'); assert.strictEqual(plex.dest_port, '32400'); assert.strictEqual(plex.dest, 'lan');
assert.ok(!g.sections.some(s => s.name && s.name.startsWith('Block cam'))); // disabled
console.log(JSON.stringify(gen('Allow-DHCPv6')), JSON.stringify(gen('Allow-IPSec-ESP')));
console.log('ALL OK');

// merge: the stock wan->router ipv4 accepts collapse, ipv6 ones stay separate
const before = Object.keys(model.connections).length;
const n = M.mergeConnections(model, Object.keys(model.connections));
const after = Object.values(model.connections);
console.log('merged', n, 'of', before);
assert.ok(n > 0);
const v4 = after.filter(c => c.family == 'ipv4' && model.objects[c.dest].type == 'router');
assert.strictEqual(v4.length, 1);
assert.ok(v4[0].service.length >= 3);
assert.strictEqual(M.generate(model).problems.length, 0);
// a drop between two allows blocks merging
const m3 = M.fromSections([
  { '.type': 'object', '.name': 'a', type: 'zone', zone: 'lan', label: 'A' },
  { '.type': 'object', '.name': 'b', type: 'zone', zone: 'wan', label: 'B' },
  { '.type': 'connection', '.name': 'c1', src: 'a', dest: 'b', service: ['b_http'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'c2', src: 'a', dest: 'b', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c3', src: 'a', dest: 'b', service: ['b_https'], action: 'ACCEPT' },
  { '.type': 'connection', '.name': 'c4', src: 'a', dest: 'b', service: ['b_dns'], action: 'ACCEPT' },
]);
assert.strictEqual(M.mergeConnections(m3, ['c1', 'c2', 'c3', 'c4']), 1);
assert.deepStrictEqual(m3.connections.c3.service, ['b_https', 'b_dns']);
assert.ok(m3.connections.c1 && !m3.connections.c4);
console.log('MERGE OK');
