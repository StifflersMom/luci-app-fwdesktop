// Run: node tests/model.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../luci-app-fwdesktop/htdocs/luci-static/resources/fwdesktop/model.js'), 'utf8');
const M = new Function('baseclass', src)({ extend: o => o });

const sections = [
  { '.type': 'object', '.name': 'router', type: 'router', label: 'Router' },
  { '.type': 'object', '.name': 'inet', type: 'zone', label: 'Internet', zone: 'wan' },
  { '.type': 'object', '.name': 'lannet', type: 'zone', label: 'LAN', zone: 'lan' },
  { '.type': 'object', '.name': 'nas', type: 'host', label: 'NAS', zone: 'lan', address: ['192.168.1.10'] },
  { '.type': 'object', '.name': 'cams', type: 'network', label: 'Cameras', zone: 'iot', address: ['10.10.0.0/24'] },
  { '.type': 'object', '.name': 'pcs', type: 'group', label: 'PCs', member: ['nas', 'cams'] },
  { '.type': 'service', '.name': 'plex', label: 'Plex', proto: 'tcp', port: ['32400'] },
  { '.type': 'service', '.name': 'web', label: 'Web', proto: 'group', member: ['b_http', 'b_https', 'b_dns'] },
  { '.type': 'connection', '.name': 'c1', src: 'lannet', dest: 'inet', service: ['web', 'b_ping'], action: 'ACCEPT', nat: 'masq' },
  { '.type': 'connection', '.name': 'c2', src: 'inet', dest: 'nas', service: ['plex'], action: 'ACCEPT', nat: 'dnat', ext_port: '40000' },
  { '.type': 'connection', '.name': 'c3', src: 'pcs', dest: 'router', service: ['b_ssh'], action: 'ACCEPT', log: '1' },
  { '.type': 'connection', '.name': 'c4', src: 'cams', dest: 'inet', service: ['b_any'], action: 'DROP' },
  { '.type': 'connection', '.name': 'c5', src: 'inet', dest: 'lannet', service: ['b_any'], action: 'ACCEPT', nat: 'dnat' },
  { '.type': 'connection', '.name': 'c6', src: 'router', dest: 'inet', service: ['b_ntp'], action: 'ACCEPT', enabled: '0' },
];
const m = M.fromSections(sections);
const g = M.generate(m);
for (const s of g.sections) console.log(JSON.stringify(s));
console.log('problems', g.problems);

const byName = n => g.sections.find(s => s['.name'] == n);
assert.deepStrictEqual(byName('fwd_c1_r0'), { '.type':'rule','.name':'fwd_c1_r0',name:'LAN → Internet',src:'lan',dest:'wan',proto:'tcp',dest_port:['80','443'],target:'ACCEPT' });
assert.strictEqual(byName('fwd_c1_n3')['.type'], 'nat'); assert.strictEqual(byName('fwd_c1_n3').proto, 'all');
assert.strictEqual(byName('fwd_c1_r1').proto, 'tcp udp');
assert.deepStrictEqual(byName('fwd_c1_r2').proto, 'icmp');
assert.deepStrictEqual(byName('fwd_c1_r2').icmp_type, ['echo-request']);
const r = byName('fwd_c2_d0');
assert.strictEqual(r['.type'], 'redirect'); assert.strictEqual(r.src_dport, '40000'); assert.strictEqual(r.dest_port, '32400'); assert.strictEqual(r.dest_ip, '192.168.1.10');
assert.strictEqual(g.sections.filter(s => s['.name'].startsWith('fwd_c3_')).length, 2); // group spans lan + iot zones
assert.strictEqual(byName('fwd_c3_r0').dest, undefined);
assert.strictEqual(byName('fwd_c3_r0').log, '1');
assert.strictEqual(byName('fwd_c4_r0').proto, 'all');
assert.ok(g.problems.some(p => p.conn == 'c5'));
assert.ok(!g.sections.some(s => s['.name'].startsWith('fwd_c6')));

// round trip
const m2 = M.fromSections(M.toSections(m));
assert.deepStrictEqual(M.generate(m2), g);

// diff
const cur = [ { '.type':'rule','.name':'keep_me', name:'x' }, { '.type':'rule','.name':'fwd_old_0', name:'old' }, Object.assign({}, byName('fwd_c1_r0'), { dest_port: '80 443', extra: 'y' }) ];
const ops = M.diffSections(cur, g.sections, M.isOwnedFirewallSection);
assert.ok(ops.some(o => o.op == 'remove' && o.name == 'fwd_old_0'));
assert.ok(!ops.some(o => o.name == 'keep_me'));
assert.ok(!ops.some(o => o.name == 'fwd_c1_r0' && o.op == 'set'));
assert.ok(ops.some(o => o.name == 'fwd_c1_r0' && o.op == 'unset' && o.option == 'extra'));
console.log('ALL OK');
