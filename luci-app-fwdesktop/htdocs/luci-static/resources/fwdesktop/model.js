'use strict';
'require baseclass';

/*
 * Object model and fw4 rule generator for the firewall desktop.
 *
 * This module is pure logic: it knows nothing about the DOM and only uses
 * plain objects, so it can be unit tested outside of LuCI.
 *
 * Model layout (stored in /etc/config/fwdesktop):
 *
 *   config object '<id>'
 *       option type    'router' | 'zone' | 'host' | 'network' | 'group' | 'ipset'
 *       option ipset   'blocklist'        (ipset: name of a fw4 "config ipset")
 *       option label   'NAS'
 *       option zone    'lan'              (not for router / group)
 *       list   address '192.168.1.10'     (host / network)
 *       list   member  '<object id>'      (group)
 *       option x / option y               (desktop position)
 *       option color   '#3a7bd5'          (optional symbol colour; UI-only options live here,
 *                                          never in /etc/config/firewall)
 *
 *   config service '<id>'
 *       option label   'Plex'
 *       option proto   'tcp' | 'udp' | 'tcpudp' | 'icmp' | 'any' | 'group' | <other protocol name, e.g. esp>
 *       list   port    '32400'            (tcp / udp / tcpudp)
 *       list   icmp_type 'echo-request'   (icmp)
 *       list   member  '<service id>'     (group)
 *
 *   config connection '<id>'
 *       option src     '<object id>'
 *       option dest    '<object id>'
 *       list   service '<service id>'
 *       option action  'ACCEPT' | 'REJECT' | 'DROP'
 *       option nat     'none' | 'masq' | 'dnat'
 *       option ext_port '8080'            (dnat: public port)
 *       option family  'ipv4' | 'ipv6'  (optional, both if unset)
 *       list   fwopt   'limit=10/sec'    (extra fw4 options passed through)
 *       option log     '0' | '1'
 *       option enabled '0' | '1'
 *       option label / option comment
 *
 * Generated firewall sections are named "fwd_<connection id>_<r|d|n><n>" so they
 * can be told apart from hand written ones and replaced as a whole.
 */

const SECTION_PREFIX = 'fwd_';

const BUILTIN_SERVICES = [
	{ id: 'b_any',      label: 'Any',          proto: 'any' },
	{ id: 'b_ping',     label: 'Ping',         proto: 'icmp', icmp_type: [ 'echo-request' ] },
	{ id: 'b_icmp',     label: 'ICMP (all)',   proto: 'icmp' },
	{ id: 'b_http',     label: 'HTTP',         proto: 'tcp',    port: [ '80' ] },
	{ id: 'b_https',    label: 'HTTPS',        proto: 'tcp',    port: [ '443' ] },
	{ id: 'b_http3',    label: 'HTTP/3 (QUIC)',proto: 'udp',    port: [ '443' ] },
	{ id: 'b_dns',      label: 'DNS',          proto: 'tcpudp', port: [ '53' ] },
	{ id: 'b_dot',      label: 'DNS over TLS', proto: 'tcp',    port: [ '853' ] },
	{ id: 'b_ntp',      label: 'NTP',          proto: 'udp',    port: [ '123' ] },
	{ id: 'b_dhcp',     label: 'DHCP',         proto: 'udp',    port: [ '67-68' ] },
	{ id: 'b_ssh',      label: 'SSH',          proto: 'tcp',    port: [ '22' ] },
	{ id: 'b_telnet',   label: 'Telnet',       proto: 'tcp',    port: [ '23' ] },
	{ id: 'b_ftp',      label: 'FTP',          proto: 'tcp',    port: [ '21' ] },
	{ id: 'b_smtp',     label: 'SMTP',         proto: 'tcp',    port: [ '25' ] },
	{ id: 'b_smtps',    label: 'SMTP submission', proto: 'tcp', port: [ '465', '587' ] },
	{ id: 'b_imaps',    label: 'IMAPS',        proto: 'tcp',    port: [ '993' ] },
	{ id: 'b_pop3s',    label: 'POP3S',        proto: 'tcp',    port: [ '995' ] },
	{ id: 'b_smb',      label: 'SMB / CIFS',   proto: 'tcp',    port: [ '445' ] },
	{ id: 'b_nfs',      label: 'NFS',          proto: 'tcpudp', port: [ '111', '2049' ] },
	{ id: 'b_rdp',      label: 'RDP',          proto: 'tcpudp', port: [ '3389' ] },
	{ id: 'b_vnc',      label: 'VNC',          proto: 'tcp',    port: [ '5900' ] },
	{ id: 'b_snmp',     label: 'SNMP',         proto: 'udp',    port: [ '161-162' ] },
	{ id: 'b_syslog',   label: 'Syslog',       proto: 'udp',    port: [ '514' ] },
	{ id: 'b_ldap',     label: 'LDAP / LDAPS', proto: 'tcp',    port: [ '389', '636' ] },
	{ id: 'b_mysql',    label: 'MySQL',        proto: 'tcp',    port: [ '3306' ] },
	{ id: 'b_pgsql',    label: 'PostgreSQL',   proto: 'tcp',    port: [ '5432' ] },
	{ id: 'b_sip',      label: 'SIP',          proto: 'tcpudp', port: [ '5060' ] },
	{ id: 'b_rtp',      label: 'RTP (10000-20000)', proto: 'udp', port: [ '10000-20000' ] },
	{ id: 'b_wireguard',label: 'WireGuard',    proto: 'udp',    port: [ '51820' ] },
	{ id: 'b_openvpn',  label: 'OpenVPN',      proto: 'udp',    port: [ '1194' ] },
	{ id: 'b_ipsec',    label: 'IPsec (IKE/NAT-T)', proto: 'udp', port: [ '500', '4500' ] },
	{ id: 'b_mqtt',     label: 'MQTT',         proto: 'tcp',    port: [ '1883', '8883' ] },
	{ id: 'b_rtmp',     label: 'RTMP',         proto: 'tcp',    port: [ '1935' ] },
	{ id: 'b_icecast',  label: 'Icecast',      proto: 'tcp',    port: [ '8000' ] },
	{ id: 'b_srt',      label: 'SRT',          proto: 'udp',    port: [ '9000' ] },
	{ id: 'b_web_alt',  label: 'HTTP alt (8080)', proto: 'tcp', port: [ '8080' ] }
].map(s => Object.assign({ builtin: true }, s));

/* fw4 options that may be passed through unchanged on generated sections */
const PASSTHROUGH_OPTS = [
	'limit', 'limit_burst', 'start_date', 'stop_date', 'start_time', 'stop_time',
	'weekdays', 'utc_time', 'src_port', 'src_mac', 'counter',
	'reflection', 'reflection_src', 'reflection_zone'
];

const OBJECT_TYPES = [ 'router', 'zone', 'host', 'network', 'group', 'ipset' ];
const ACTIONS = [ 'ACCEPT', 'REJECT', 'DROP' ];

function toList(v) {
	if (v == null || v === '')
		return [];
	return Array.isArray(v) ? v.filter(x => x != null && x !== '') : String(v).split(/\s+/).filter(Boolean);
}

function trunc(s, n) {
	s = String(s || '');
	return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function uniq(list) {
	return list.filter((v, i) => list.indexOf(v) == i);
}

function randomId(prefix, taken) {
	for (;;) {
		let id = prefix;
		for (let i = 0; i < 6; i++)
			id += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36));
		if (!taken || !taken[id])
			return id;
	}
}

/* --- model (de)serialisation ------------------------------------------ */

/**
 * Build a model from the list of fwdesktop uci sections
 * (as returned by uci.sections('fwdesktop')).
 */
function fromSections(sections) {
	const model = { objects: {}, services: {}, connections: {}, order: [] };

	for (const s of sections || []) {
		const id = s['.name'];

		switch (s['.type']) {
		case 'object':
			model.objects[id] = {
				id: id,
				type: OBJECT_TYPES.includes(s.type) ? s.type : 'host',
				label: s.label || id,
				zone: s.zone || null,
				address: toList(s.address),
				member: toList(s.member),
				ipset: s.ipset || '',
				color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color.toLowerCase() : '',
				x: +s.x || 0,
				y: +s.y || 0,
				comment: s.comment || ''
			};
			break;

		case 'service':
			model.services[id] = {
				id: id,
				label: s.label || id,
				proto: s.proto || 'tcp',
				port: toList(s.port),
				icmp_type: toList(s.icmp_type),
				member: toList(s.member)
			};
			break;

		case 'connection':
			model.connections[id] = {
				id: id,
				src: s.src,
				dest: s.dest,
				service: toList(s.service),
				action: ACTIONS.includes(s.action) ? s.action : 'ACCEPT',
				nat: [ 'masq', 'dnat' ].includes(s.nat) ? s.nat : 'none',
				ext_port: s.ext_port || '',
				family: [ 'ipv4', 'ipv6' ].includes(s.family) ? s.family : '',
				fwopt: toList(s.fwopt),
				log: s.log == '1',
				enabled: s.enabled != '0',
				label: s.label || '',
				comment: s.comment || ''
			};
			model.order.push(id);
			break;
		}
	}

	return model;
}

function compact(o) {
	const r = {};
	for (const k in o) {
		const v = o[k];
		if (v == null || v === '' || (Array.isArray(v) && !v.length))
			continue;
		r[k] = Array.isArray(v) ? v.slice() : String(v);
	}
	return r;
}

/**
 * Turn a model back into a list of desired uci sections:
 *   [ { '.type': ..., '.name': ..., option: value, ... }, ... ]
 */
function toSections(model) {
	const out = [];

	for (const id in model.objects) {
		const o = model.objects[id];
		out.push(Object.assign({ '.type': 'object', '.name': id }, compact({
			type: o.type,
			label: o.label,
			zone: (o.type == 'router' || o.type == 'group') ? null : o.zone,
			address: (o.type == 'host' || o.type == 'network') ? o.address : null,
			member: o.type == 'group' ? o.member : null,
			ipset: o.type == 'ipset' ? o.ipset : null,
			color: o.color || null,
			x: Math.round(o.x),
			y: Math.round(o.y),
			comment: o.comment
		})));
	}

	for (const id in model.services) {
		const s = model.services[id];
		out.push(Object.assign({ '.type': 'service', '.name': id }, compact({
			label: s.label,
			proto: s.proto,
			port: [ 'tcp', 'udp', 'tcpudp' ].includes(s.proto) ? s.port : null,
			icmp_type: s.proto == 'icmp' ? s.icmp_type : null,
			member: s.proto == 'group' ? s.member : null
		})));
	}

	for (const id of connectionOrder(model)) {
		const c = model.connections[id];
		out.push(Object.assign({ '.type': 'connection', '.name': id }, compact({
			src: c.src,
			dest: c.dest,
			service: c.service,
			action: c.action,
			nat: c.nat != 'none' ? c.nat : null,
			ext_port: c.nat == 'dnat' ? c.ext_port : null,
			family: c.family || null,
			fwopt: c.fwopt,
			log: c.log ? '1' : null,
			enabled: c.enabled ? null : '0',
			label: c.label,
			comment: c.comment
		})));
	}

	return out;
}

function connectionOrder(model) {
	const seen = {};
	const order = (model.order || []).filter(id => model.connections[id] && !seen[id] && (seen[id] = true));
	for (const id in model.connections)
		if (!seen[id])
			order.push(id);
	model.order = order;
	return order;
}

/* --- lookup helpers --------------------------------------------------- */

function allServices(model) {
	const r = {};
	for (const s of BUILTIN_SERVICES)
		r[s.id] = s;
	for (const id in model.services)
		r[id] = model.services[id];
	return r;
}

function serviceLabel(model, id) {
	const s = allServices(model)[id];
	return s ? s.label : id;
}

function describeService(s) {
	switch (s.proto) {
	case 'any':    return 'any protocol';
	case 'group':  return 'group of ' + s.member.length;
	case 'icmp':   return 'ICMP' + (toList(s.icmp_type).length ? ' ' + toList(s.icmp_type).join(', ') : '');
	case 'tcpudp': return 'TCP+UDP ' + toList(s.port).join(', ');
	default:       return String(s.proto).toUpperCase() + (toList(s.port).length ? ' ' + toList(s.port).join(', ') : '');
	}
}

function isIPv6(a) {
	return String(a).indexOf(':') > -1;
}

/**
 * Resolve an object into a list of "endpoints":
 *   [ { zone: 'lan', addrs: [ ... ] | null, router: false }, ... ]
 * addrs == null means "anything in that zone".
 */
function resolveObject(model, id, errors, seen) {
	const o = model.objects[id];
	seen = seen || {};

	if (!o) {
		errors.push('Unknown object "' + id + '"');
		return [];
	}

	if (seen[id]) {
		errors.push('Group "' + o.label + '" contains itself');
		return [];
	}

	switch (o.type) {
	case 'router':
		return [ { zone: null, addrs: null, router: true } ];

	case 'zone':
		if (!o.zone) {
			errors.push('Object "' + o.label + '" has no zone');
			return [];
		}
		return [ { zone: o.zone, addrs: null, router: false } ];

	case 'host':
	case 'network':
		if (!o.zone) {
			errors.push('Object "' + o.label + '" has no zone');
			return [];
		}
		if (!o.address.length) {
			errors.push('Object "' + o.label + '" has no address');
			return [];
		}
		return [ { zone: o.zone, addrs: o.address.slice(), router: false } ];

	case 'ipset':
		if (!o.zone) {
			errors.push('Object "' + o.label + '" has no zone');
			return [];
		}
		if (!o.ipset) {
			errors.push('Object "' + o.label + '" has no IP set');
			return [];
		}
		return [ { zone: o.zone, addrs: null, router: false, ipset: o.ipset } ];

	case 'group': {
		const byZone = {};
		const result = [];
		seen[id] = true;

		for (const mid of o.member) {
			for (const ep of resolveObject(model, mid, errors, seen)) {
				if (ep.router) {
					errors.push('Group "' + o.label + '" may not contain the router object');
					continue;
				}
				/* sets cannot be folded into address lists, keep them as own endpoints */
				if (ep.ipset) {
					if (!result.some(r => r.ipset == ep.ipset && r.zone == ep.zone))
						result.push(Object.assign({}, ep));
					continue;
				}
				let e = byZone[ep.zone];
				if (!e) {
					e = byZone[ep.zone] = { zone: ep.zone, addrs: [], router: false };
					result.push(e);
				}
				if (e.addrs != null)
					e.addrs = (ep.addrs == null) ? null : uniq(e.addrs.concat(ep.addrs));
			}
		}

		delete seen[id];

		if (!result.length)
			errors.push('Group "' + o.label + '" is empty');

		return result;
	}
	}

	return [];
}

/**
 * Expand service ids into protocol buckets:
 *   [ { proto: 'tcp', ports: [ '80', '443' ] | null, icmp: [ ... ] | null } ]
 * ports == null means all ports of that protocol.
 */
function resolveServices(model, ids, errors) {
	const svcs = allServices(model);
	const atoms = [];

	const expand = (id, seen) => {
		const s = svcs[id];
		if (!s) {
			errors.push('Unknown service "' + id + '"');
			return;
		}
		if (s.proto == 'group') {
			if (seen[id]) {
				errors.push('Service group "' + s.label + '" contains itself');
				return;
			}
			seen[id] = true;
			for (const m of toList(s.member))
				expand(m, seen);
			delete seen[id];
			return;
		}
		atoms.push(s);
	};

	for (const id of ids)
		expand(id, {});

	if (!atoms.length || atoms.some(s => s.proto == 'any'))
		return [ { proto: 'all', ports: null, icmp: null } ];

	const buckets = {};
	const order = [];
	const bucket = (key) => {
		if (!buckets[key]) {
			buckets[key] = { proto: key, ports: [], icmp: [] };
			order.push(key);
		}
		return buckets[key];
	};

	for (const s of atoms) {
		if (s.proto == 'icmp') {
			const b = bucket('icmp');
			const types = toList(s.icmp_type);
			b.icmp = (b.icmp == null || !types.length) ? null : uniq(b.icmp.concat(types));
		}
		else if ([ 'tcp', 'udp', 'tcpudp' ].includes(s.proto)) {
			const key = (s.proto == 'tcpudp') ? 'tcp udp' : s.proto;
			const b = bucket(key);
			const ports = toList(s.port);
			b.ports = (b.ports == null || !ports.length) ? null : uniq(b.ports.concat(ports));
		}
		else {
			bucket(String(s.proto)).ports = null;
		}
	}

	return order.map(k => buckets[k]).map(b => {
		if (b.proto != 'icmp')
			b.icmp = null;
		else
			b.ports = null;
		return b;
	});
}

/* --- rule generator --------------------------------------------------- */

function sanitize(id) {
	return String(id).replace(/[^A-Za-z0-9_]/g, '_');
}

function familyOf(addrs) {
	if (!addrs || !addrs.length)
		return null;
	const v6 = addrs.filter(isIPv6).length;
	if (v6 == addrs.length) return 'ipv6';
	if (v6 == 0) return 'ipv4';
	return 'mixed';
}

/**
 * Generate fw4 sections for the whole model.
 *
 * Returns { sections: [ {'.type','.name',...options} ], problems: [ { conn, msg } ] }
 */
function generate(model) {
	const sections = [];
	const problems = [];

	for (const cid of connectionOrder(model)) {
		const c = model.connections[cid];
		const errors = [];
		const base = SECTION_PREFIX + sanitize(cid) + '_';
		let n = 0;

		if (!c.enabled)
			continue;

		const srcO = model.objects[c.src], dstO = model.objects[c.dest];
		const title = c.label || ((srcO ? srcO.label : '?') + ' → ' + (dstO ? dstO.label : '?'));

		const srcEps = resolveObject(model, c.src, errors);
		const dstEps = resolveObject(model, c.dest, errors);
		const buckets = resolveServices(model, c.service, errors);

		if (c.nat == 'dnat') {
			if (c.action != 'ACCEPT')
				errors.push('Port forwarding requires the action "allow"');
			if (!dstO || dstO.type != 'host' || dstO.address.length != 1 || isIPv6(dstO.address[0]))
				errors.push('Port forwarding needs a host object with exactly one IPv4 address as target');
			if (srcEps.some(e => e.router))
				errors.push('Port forwarding cannot start at the router itself');
			if (buckets.some(b => ![ 'tcp', 'udp', 'tcp udp' ].includes(b.proto) || b.ports == null))
				errors.push('Port forwarding needs TCP/UDP services with ports');
			if (c.family == 'ipv6')
				errors.push('Port forwarding is only supported for IPv4');
		}

		if (c.nat == 'masq' && (srcEps.some(e => e.router) || dstEps.some(e => e.router)))
			errors.push('Masquerading only applies to forwarded traffic, not to the router itself');
		if (c.nat == 'masq' && (srcEps.some(e => e.ipset) || dstEps.some(e => e.ipset)))
			errors.push('Masquerading cannot be limited to an IP set (fw4 NAT rules do not support sets); use the zone instead');
		if (c.nat == 'dnat' && dstEps.some(e => e.ipset))
			errors.push('A port forward target must be a host, not an IP set');

		if (errors.length) {
			for (const msg of uniq(errors))
				problems.push({ conn: cid, msg: msg });
			continue;
		}

		const extPorts = toList(c.ext_port);

		/* extra fw4 options, only from the whitelist and never overriding generated ones */
		const withExtra = (sec) => {
			for (const kv of (c.fwopt || [])) {
				const i = String(kv).indexOf('='), k = kv.substring(0, i).trim(), v = kv.substring(i + 1).trim();
				if (i > 0 && PASSTHROUGH_OPTS.includes(k) && v !== '' && !(k in sec))
					sec[k] = v;
			}
			return sec;
		};

		for (const s of srcEps) {
			for (const d of dstEps) {
				if (s.router && d.router) {
					problems.push({ conn: cid, msg: 'A connection from the router to itself has no effect' });
					continue;
				}

				if (s.ipset && d.ipset) {
					problems.push({ conn: cid, msg: 'A firewall rule can match only one IP set; use an address object on one side' });
					continue;
				}
				const setMatch = s.ipset ? s.ipset + ' src' : (d.ipset ? d.ipset + ' dest' : null);

				const sf = familyOf(s.addrs), df = familyOf(d.addrs);
				if (sf && df && sf != 'mixed' && df != 'mixed' && sf != df) {
					problems.push({ conn: cid, msg: 'Source and destination use different IP families' });
					continue;
				}
				if (c.family && ((sf && sf != 'mixed' && sf != c.family) || (df && df != 'mixed' && df != c.family))) {
					problems.push({ conn: cid, msg: 'Addresses do not match the selected IP family' });
					continue;
				}

				for (const b of buckets) {
					if (c.nat == 'dnat') {
						const ports = b.ports;
						if (extPorts.length && extPorts.length != ports.length) {
							problems.push({ conn: cid, msg: 'Number of public ports must match the number of service ports' });
							break;
						}
						/* fw4 redirects take a single src_ip, so emit one redirect per source address */
						const srcIps = s.addrs ? s.addrs.filter(a => !isIPv6(a)) : [ null ];
						if (!srcIps.length) {
							problems.push({ conn: cid, msg: 'Port forwarding is IPv4 only, but the source has only IPv6 addresses' });
							break;
						}
						ports.forEach((p, i) => srcIps.forEach(ip => {
							sections.push(withExtra(compact({
								'.type': 'redirect',
								'.name': base + 'd' + (n++),
								name: title + ' (' + (extPorts[i] || p) + ')' + (srcIps.length > 1 ? ' ' + ip : ''),
								target: 'DNAT',
								family: 'ipv4',
								src: s.zone,
								src_ip: ip,
								ipset: setMatch,
								src_dport: extPorts[i] || p,
								dest: d.zone,
								dest_ip: d.addrs[0],
								dest_port: p,
								proto: b.proto,
								log: c.log ? '1' : null
							})));
						}));
						continue;
					}

					const rule = {
						'.type': 'rule',
						'.name': base + 'r' + (n++),
						name: title,
						src: s.router ? null : s.zone,
						dest: d.router ? null : d.zone,
						src_ip: s.addrs,
						dest_ip: d.addrs,
						ipset: setMatch,
						proto: b.proto,
						dest_port: b.ports,
						icmp_type: b.icmp,
						target: c.action,
						family: c.family || null,
						log: c.log ? '1' : null
					};

					if (b.proto == 'icmp' && (c.family == 'ipv6' || sf == 'ipv6' || df == 'ipv6'))
						rule.proto = 'icmpv6';

					sections.push(withExtra(compact(rule)));
				}

				if (c.nat == 'masq' && c.action == 'ACCEPT' && c.family != 'ipv6') {
					/* fw4 nat sections take a single src_ip / dest_ip each */
					const sIps = s.addrs ? s.addrs.filter(a => !isIPv6(a)) : [ null ];
					const dIps = d.addrs ? d.addrs.filter(a => !isIPv6(a)) : [ null ];
					for (const sip of sIps)
						for (const dip of dIps)
							sections.push(compact({
								'.type': 'nat',
								'.name': base + 'n' + (n++),
								name: title + ' (NAT)',
								family: 'ipv4',
								src: d.zone,
								src_ip: sip,
								dest_ip: dip,
								proto: 'all',
								target: 'MASQUERADE'
							}));
				}
			}
		}
	}

	return { sections: sections, problems: problems };
}

/* --- section diffing -------------------------------------------------- */

/**
 * Compute the uci operations needed to turn the current set of sections
 * into the desired set. Only sections matched by `owned(section)` are
 * considered; everything else is left untouched.
 *
 * Returns a list of { op: 'add'|'remove'|'set'|'unset', ... } operations.
 */
function diffSections(current, desired, owned) {
	const ops = [];
	const cur = {};

	for (const s of current)
		if (owned(s))
			cur[s['.name']] = s;

	const want = {};
	for (const s of desired)
		want[s['.name']] = s;

	for (const name in cur)
		if (!want[name] || want[name]['.type'] != cur[name]['.type'])
			ops.push({ op: 'remove', name: name });

	for (const s of desired) {
		const name = s['.name'];
		const c = (cur[name] && cur[name]['.type'] == s['.type']) ? cur[name] : null;

		if (!c)
			ops.push({ op: 'add', type: s['.type'], name: name });

		for (const k in s) {
			if (k.charAt(0) == '.')
				continue;
			const nv = s[k];
			const ov = c ? c[k] : null;
			if (JSON.stringify(nv) !== JSON.stringify(Array.isArray(nv) ? toList(ov) : ov))
				ops.push({ op: 'set', name: name, option: k, value: nv });
		}

		if (c)
			for (const k in c)
				if (k.charAt(0) != '.' && !(k in s))
					ops.push({ op: 'unset', name: name, option: k });
	}

	return ops;
}

function isOwnedFirewallSection(s) {
	return String(s['.name']).indexOf(SECTION_PREFIX) == 0;
}

/* --- merging parallel connections --------------------------------------- */

function mergeKey(c) {
	return JSON.stringify([ c.src, c.dest, c.action, c.nat, c.family || '', (c.fwopt || []).slice().sort(), !!c.log, !!c.enabled ]);
}

/**
 * Merge connections among `ids` that only differ in their services
 * (same endpoints, action, NAT mode, family, options, log and state).
 * Port forwards are never merged. A connection is only merged into an
 * earlier one if no connection with a different action lies between them
 * in the evaluation order, so the resulting rule set behaves the same.
 *
 * Returns the number of connections that were folded into others.
 */
function mergeConnections(model, ids) {
	const order = connectionOrder(model);
	const pos = {};
	order.forEach((id, i) => pos[id] = i);

	const cand = ids.filter(id => model.connections[id] && model.connections[id].nat != 'dnat')
		.sort((a, b) => pos[a] - pos[b]);

	let merged = 0;
	const heads = {};

	for (const id of cand) {
		const c = model.connections[id];
		const key = mergeKey(c);
		const head = heads[key] ? model.connections[heads[key]] : null;

		if (head) {
			const between = order.slice(pos[head.id] + 1, pos[id]).map(x => model.connections[x]).filter(Boolean);
			if (between.every(o => o.action == c.action || !o.enabled)) {
				head.service = uniq(head.service.concat(c.service));
				if (!head.label && c.label)
					head.label = c.label;
				else if (head.label && c.label && head.label != c.label)
					head.label = trunc(head.label + ', ' + c.label, 60);
				delete model.connections[id];
				model.order = model.order.filter(x => x != id);
				merged++;
				continue;
			}
		}

		heads[key] = id;
	}

	if (merged)
		connectionOrder(model);

	return merged;
}

/* --- import of existing firewall sections ------------------------------ */

const RULE_KEYS = [ 'name', 'enabled', 'src', 'dest', 'src_ip', 'dest_ip', 'proto',
	'dest_port', 'icmp_type', 'target', 'family', 'log', 'ipset' ];
const REDIRECT_KEYS = [ 'name', 'enabled', 'src', 'dest', 'src_ip', 'src_dport', 'dest_ip',
	'dest_port', 'proto', 'family', 'log', 'target', 'ipset' ];

function splitList(v) {
	return toList(v).reduce((a, x) => a.concat(String(x).split(/[\s,]+/)), []).filter(Boolean);
}

function sameSet(a, b) {
	a = a.slice().sort(); b = b.slice().sort();
	return a.length == b.length && a.every((x, i) => x == b[i]);
}

function isHostAddr(a) {
	return !/[\/-]/.test(a) || /\/(32|128)$/.test(a);
}

/**
 * Convert existing (hand written) fw4 rule and redirect sections into
 * objects, services and connections. The model is modified in place.
 *
 * opts.only            - list of section names to import (default: all convertible)
 * opts.zones           - list of known zone names
 * opts.zoneForAddress  - function(addr) returning the zone of an address, or null
 * opts.labels          - { wan: 'Internet', router: 'This router' } labels for new objects
 *
 * Returns [ { sid, type, name, ok, reason, conn } ] for every candidate section.
 */
function importFirewall(model, fwSections, opts) {
	opts = opts || {};
	const zones = opts.zones || [];
	const labels = opts.labels || {};
	const results = [];
	const newObjs = [];

	const ys = Object.values(model.objects).map(o => o.y);
	const baseY = (ys.length ? Math.max.apply(null, ys) : 0) + 130;

	const addObject = (o) => {
		o.id = randomId('o', model.objects);
		const k = newObjs.length;
		o.x = 120 + (k % 5) * 200;
		o.y = baseY + Math.floor(k / 5) * 100;
		o.comment = o.comment || '';
		o.member = o.member || [];
		o.address = o.address || [];
		model.objects[o.id] = o;
		newObjs.push(o);
		return o.id;
	};

	const routerObject = () => {
		for (const id in model.objects)
			if (model.objects[id].type == 'router')
				return id;
		return addObject({ type: 'router', label: labels.router || 'This router', zone: null });
	};

	const endpointObject = (zone, addrs) => {
		if (!addrs.length) {
			for (const id in model.objects)
				if (model.objects[id].type == 'zone' && model.objects[id].zone == zone)
					return id;
			return addObject({ type: 'zone', zone: zone, label: /^wan/.test(zone) ? (labels.wan || 'Internet') : zone.toUpperCase() });
		}

		const type = (addrs.length == 1 && isHostAddr(addrs[0])) ? 'host' : 'network';
		const address = addrs.map(a => type == 'host' ? a.replace(/\/(32|128)$/, '') : a);

		for (const id in model.objects) {
			const o = model.objects[id];
			if (o.type == type && o.zone == zone && sameSet(o.address, address))
				return id;
		}

		return addObject({ type: type, zone: zone, address: address, label: trunc(address.join(', '), 24) });
	};

	const ipsetObject = (zone, name) => {
		for (const id in model.objects) {
			const o = model.objects[id];
			if (o.type == 'ipset' && o.zone == zone && o.ipset == name)
				return id;
		}
		return addObject({ type: 'ipset', zone: zone, ipset: name, label: name });
	};

	const fwSets = {};
	for (const sec of fwSections || [])
		if (sec['.type'] == 'ipset' && sec.name)
			fwSets[sec.name] = sec;

	/* returns { name, dir: 'src'|'dest' } or a string with the reason */
	const parseSetMatch = (val) => {
		if (val == null || val === '')
			return null;
		val = toList(val).join(' ').trim();
		if (val.charAt(0) == '!')
			return 'Negated IP set matches ("!") are not supported';
		const parts = val.split(/[\s,]+/);
		const name = parts[0];
		let dirs = parts.slice(1).map(d => d == 'dst' ? 'dest' : d).filter(d => d == 'src' || d == 'dest');
		if (!fwSets[name])
			return 'IP set "' + name + '" is not defined in the firewall configuration';
		if (!dirs.length)
			dirs = toList(fwSets[name].match).map(m => (m.indexOf('dest') == 0 || m.indexOf('dst') == 0) ? 'dest' : 'src');
		dirs = uniq(dirs.length ? dirs : [ 'src' ]);
		if (dirs.length != 1)
			return 'IP set "' + name + '" matches source and destination at once';
		return { name: name, dir: dirs[0] };
	};

	const serviceFor = (proto, ports, icmp) => {
		const svcs = allServices(model);
		for (const id in svcs) {
			const s = svcs[id];
			if (s.proto != proto)
				continue;
			if ([ 'tcp', 'udp', 'tcpudp' ].includes(proto) && !sameSet(toList(s.port), ports))
				continue;
			if (proto == 'icmp' && !sameSet(toList(s.icmp_type), icmp))
				continue;
			return id;
		}

		const id = randomId('s', model.services);
		const pname = { tcpudp: 'TCP+UDP', icmp: 'ICMP' }[proto] || proto.toUpperCase();
		model.services[id] = {
			id: id,
			label: trunc(pname + ' ' + (proto == 'icmp' ? icmp.join(', ') : ports.join(', ')), 30).trim(),
			proto: proto,
			port: ports,
			icmp_type: icmp,
			member: []
		};
		return id;
	};

	/* returns { services, family } or a string with the reason */
	const servicesFor = (sec, family, portsKey) => {
		let protos = splitList(sec.proto || 'tcp udp').map(p => p.toLowerCase());
		const ports = splitList(sec[portsKey]);
		const icmp = splitList(sec.icmp_type);

		if (protos.includes('all') || protos.includes('any'))
			return ports.length ? 'Ports together with protocol "all" are not supported' : { services: [ 'b_any' ], family: family };

		if (protos.includes('icmpv6')) {
			if (family == 'ipv4')
				return 'ICMPv6 together with family IPv4';
			family = 'ipv6';
			protos = protos.map(p => p == 'icmpv6' ? 'icmp' : p);
		}

		const out = [];
		const tcp = protos.includes('tcp'), udp = protos.includes('udp');
		if (tcp && udp) out.push(serviceFor('tcpudp', ports, []));
		else if (tcp) out.push(serviceFor('tcp', ports, []));
		else if (udp) out.push(serviceFor('udp', ports, []));
		else if (ports.length) return 'Ports are only supported for TCP and UDP';

		for (const p of uniq(protos)) {
			if (p == 'tcp' || p == 'udp')
				continue;
			if (!/^[a-z0-9_-]+$/.test(p))
				return 'Unsupported protocol "' + p + '"';
			out.push(serviceFor(p, [], p == 'icmp' ? icmp : []));
		}

		return { services: uniq(out), family: family };
	};

	const checkCommon = (sec, allowed) => {
		for (const k in sec) {
			if (k.charAt(0) == '.' || allowed.includes(k) || PASSTHROUGH_OPTS.includes(k))
				continue;
			return 'Uses option "' + k + '", which the desktop cannot express';
		}
		for (const k of [ 'src_ip', 'dest_ip', 'src_dport', 'dest_port', 'proto', 'icmp_type', 'src_mac', 'src_port' ])
			if (splitList(sec[k]).some(v => v.charAt(0) == '!'))
				return 'Negated matches ("!") are not supported';
		for (const k of [ 'src', 'dest' ])
			if (sec[k] != null && sec[k] != '*' && !zones.includes(sec[k]))
				return 'Unknown zone "' + sec[k] + '"';
		if (sec.src == '*' || sec.dest == '*')
			return '"Any zone" is not supported, create one connection per zone instead';
		const fam = sec.family;
		if (fam != null && ![ 'any', 'ipv4', 'ipv6', '4', '6', 'inet' ].includes(fam))
			return 'Unsupported family "' + fam + '"';
		return null;
	};

	const normFamily = f => (f == 'ipv4' || f == '4') ? 'ipv4' : (f == 'ipv6' || f == '6') ? 'ipv6' : '';

	const fwopts = sec => PASSTHROUGH_OPTS.filter(k => sec[k] != null && sec[k] !== '').map(k => k + '=' + toList(sec[k]).join(' '));

	const convertRule = (sec) => {
		let r = checkCommon(sec, RULE_KEYS);
		if (r) return r;

		const target = String(sec.target || 'DROP').toUpperCase();
		if (!ACTIONS.includes(target))
			return 'Target "' + target + '" is not supported';
		if (sec.src == null && sec.dest == null)
			return 'Rules for traffic from the router to itself are not supported';

		const svc = servicesFor(sec, normFamily(sec.family), 'dest_port');
		if (typeof svc == 'string')
			return svc;

		const set = parseSetMatch(sec.ipset);
		if (typeof set == 'string')
			return set;
		if (set) {
			const zone = set.dir == 'src' ? sec.src : sec.dest;
			if (zone == null)
				return 'IP set matches on the router itself are not supported';
			if (splitList(set.dir == 'src' ? sec.src_ip : sec.dest_ip).length)
				return 'Address and IP set on the same side are not supported';
		}

		const side = (dir, zone, ips) => (zone == null) ? routerObject()
			: (set && set.dir == dir) ? ipsetObject(zone, set.name) : endpointObject(zone, splitList(ips));

		const src = side('src', sec.src, sec.src_ip);
		const dest = side('dest', sec.dest, sec.dest_ip);

		if (sec.src == null && splitList(sec.src_ip).length || sec.dest == null && splitList(sec.dest_ip).length)
			return 'Addresses of the router itself are not supported';

		return {
			src: src, dest: dest, service: svc.services, action: target, nat: 'none', ext_port: '',
			family: svc.family, fwopt: fwopts(sec)
		};
	};

	const convertRedirect = (sec) => {
		let r = checkCommon(sec, REDIRECT_KEYS);
		if (r) return r;

		if (String(sec.target || 'DNAT').toUpperCase() != 'DNAT')
			return 'Only port forwards (DNAT) can be imported';
		if (normFamily(sec.family) == 'ipv6')
			return 'IPv6 port forwards are not supported';
		if (!sec.src)
			return 'Port forward without source zone';
		if (!sec.src_dport)
			return 'Port forward without external port';

		const destIp = splitList(sec.dest_ip);
		if (destIp.length != 1 || isIPv6(destIp[0]) || !isHostAddr(destIp[0]))
			return 'Port forward needs exactly one internal IPv4 address';

		const destZone = sec.dest || (opts.zoneForAddress ? opts.zoneForAddress(destIp[0]) : null);
		if (!destZone)
			return 'Cannot determine the internal zone of ' + destIp[0];
		if (!zones.includes(destZone))
			return 'Unknown zone "' + destZone + '"';

		const protos = splitList(sec.proto || 'tcp udp').map(p => p.toLowerCase());
		if (!protos.length || protos.some(p => p != 'tcp' && p != 'udp'))
			return 'Port forwards can only be imported for TCP and UDP';

		const ext = splitList(sec.src_dport), int = splitList(sec.dest_port);
		if (ext.length != 1 || int.length > 1)
			return 'Port forwards with several port lists are not supported';

		const svc = servicesFor({ proto: protos.join(' '), port: int.length ? int : ext }, 'ipv4', 'port');
		if (typeof svc == 'string')
			return svc;

		const set = parseSetMatch(sec.ipset);
		if (typeof set == 'string')
			return set;
		if (set && set.dir != 'src')
			return 'Port forwards can only match an IP set on the source side';
		if (set && splitList(sec.src_ip).length)
			return 'Address and IP set on the same side are not supported';

		return {
			src: set ? ipsetObject(sec.src, set.name) : endpointObject(sec.src, splitList(sec.src_ip)),
			dest: endpointObject(destZone, destIp),
			service: svc.services, action: 'ACCEPT', nat: 'dnat',
			ext_port: (int.length && int[0] != ext[0]) ? ext[0] : '',
			family: '', fwopt: fwopts(sec)
		};
	};

	for (const sec of fwSections || []) {
		const type = sec['.type'];
		if (![ 'rule', 'redirect', 'nat' ].includes(type) || isOwnedFirewallSection(sec))
			continue;

		const res = { sid: sec['.name'], type: type, name: sec.name || sec['.name'], ok: false, reason: null, conn: null };
		results.push(res);

		if (opts.only && !opts.only.includes(res.sid)) {
			res.reason = 'not selected';
			continue;
		}

		if (type == 'nat') {
			res.reason = 'NAT rules are not imported; use masquerading on a connection instead';
			continue;
		}

		/* convert on a scratch copy so failed conversions leave no stray objects behind */
		const snapshot = { objects: Object.assign({}, model.objects), services: Object.assign({}, model.services), n: newObjs.length };
		const out = (type == 'rule') ? convertRule(sec) : convertRedirect(sec);

		if (typeof out == 'string') {
			model.objects = snapshot.objects;
			model.services = snapshot.services;
			newObjs.length = snapshot.n;
			res.reason = out;
			continue;
		}

		const cid = randomId('c', model.connections);
		model.connections[cid] = Object.assign({
			id: cid, log: sec.log != null && sec.log != '0', enabled: sec.enabled != '0',
			label: sec.name || '', comment: ''
		}, out);
		model.order = (model.order || []).concat([ cid ]);
		res.ok = true;
		res.conn = cid;
	}

	return results;
}

return baseclass.extend({
	SECTION_PREFIX: SECTION_PREFIX,
	PASSTHROUGH_OPTS: PASSTHROUGH_OPTS,
	BUILTIN_SERVICES: BUILTIN_SERVICES,
	OBJECT_TYPES: OBJECT_TYPES,
	ACTIONS: ACTIONS,

	toList: toList,
	randomId: randomId,
	fromSections: fromSections,
	toSections: toSections,
	connectionOrder: connectionOrder,
	allServices: allServices,
	serviceLabel: serviceLabel,
	describeService: describeService,
	resolveObject: resolveObject,
	resolveServices: resolveServices,
	generate: generate,
	diffSections: diffSections,
	isOwnedFirewallSection: isOwnedFirewallSection,
	importFirewall: importFirewall,
	mergeConnections: mergeConnections
});
