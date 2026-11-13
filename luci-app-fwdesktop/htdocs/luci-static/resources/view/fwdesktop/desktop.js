'use strict';
'require view';
'require dom';
'require ui';
'require uci';
'require rpc';
'require fwdesktop.model as fwm';

/* bump together with PKG_RELEASE so browsers fetch the matching stylesheet */
const ASSET_REV = '1.0.0-8';

/* defined here because jsmin cannot parse a regex literal right after '=>' */
const FWOPT_RE = /^[a-z_]+=.+/;

const NODE_W = 172;
const NODE_H = 58;
const GRID = 8;
const SVGNS = 'http://www.w3.org/2000/svg';

const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

const callNetworkDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { 'interface': [] }
});

const TYPE_LABELS = {
	router:  _('Router'),
	zone:    _('Zone'),
	host:    _('Host'),
	network: _('Network'),
	group:   _('Group'),
	ipset:   _('IP set')
};

const ACTION_LABELS = {
	ACCEPT: _('Allow'),
	REJECT: _('Reject'),
	DROP:   _('Drop')
};

const ICONS = {
	router:  'M-8,0 h16 v7 h-16 z M-4,0 L-6,-7 M4,0 L6,-7 M-4,3.5 h1 M0,3.5 h1',
	zone:    'M-7,0 a7,7 0 1,0 14,0 a7,7 0 1,0 -14,0 M-7,0 h14 M0,-7 c-4,4 -4,10 0,14 c4,-4 4,-10 0,-14',
	host:    'M-8,-6 h16 v10 h-16 z M-4,8 h8 M0,4 v4',
	network: 'M-2.5,-8 h5 v4 h-5 z M-9,4 h5 v4 h-5 z M4,4 h5 v4 h-5 z M0,-4 v4 M-6.5,4 v-4 h13 v4',
	group:   'M-8,-3 h10 v10 h-10 z M-3,-3 v-5 h10 v10 h-5',
	ipset:   'M-8,-6 h2 M-3,-6 h11 M-8,0 h2 M-3,0 h11 M-8,6 h2 M-3,6 h11'
};

const ICMP_TYPES = [
	'echo-request', 'echo-reply', 'destination-unreachable', 'time-exceeded',
	'parameter-problem', 'packet-too-big', 'router-advertisement',
	'router-solicitation', 'neighbour-advertisement', 'neighbour-solicitation'
];

function S(tag, attrs, children) {
	const el = document.createElementNS(SVGNS, tag);
	for (const k in (attrs || {}))
		if (attrs[k] != null)
			el.setAttribute(k, attrs[k]);
	for (const c of (children || []))
		if (c != null)
			el.appendChild(typeof c == 'string' ? document.createTextNode(c) : c);
	return el;
}

function trunc(s, n) {
	s = String(s || '');
	return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function snap(v) {
	return Math.round(v / GRID) * GRID;
}

function ip4ToInt(ip) {
	const m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	return m ? (((+m[1]) << 24) >>> 0) + ((+m[2]) << 16) + ((+m[3]) << 8) + (+m[4]) : null;
}

function clone(o) {
	return JSON.parse(JSON.stringify(o));
}

return view.extend({
	load() {
		return Promise.all([
			uci.load([ 'fwdesktop', 'firewall', 'network' ]),
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(callNetworkDump(), [])
		]);
	},

	/* --- setup -------------------------------------------------------- */

	render(data) {
		this.hints = data[1] || {};
		this.ifaces = data[2] || [];
		this.zones = uci.sections('firewall', 'zone').map(z => z.name).filter(Boolean);
		this.model = fwm.fromSections(uci.sections('fwdesktop'));
		this.pan = { x: 40, y: 30, k: 1 };
		this.sel = null;
		this.dirty = false;
		this.showPolicies = true;
		try { this.showPolicies = localStorage.getItem('fwdesktop.policies') != '0'; } catch (e) {}

		if (!Object.keys(this.model.objects).length)
			this.seedDefaults();

		document.querySelector('head').appendChild(E('link', {
			'rel': 'stylesheet',
			'href': L.resource('fwdesktop/desktop.css') + '?v=' + ASSET_REV + (L.env.resource_version ? '-' + L.env.resource_version : '')
		}));

		this.statusEl = E('span', { 'class': 'fwd-status' });
		this.buildCanvas();

		this.connPane = E('div');
		this.objPane = E('div');
		this.svcPane = E('div');
		this.previewPane = E('div');

		const tabs = E('div', {}, [
			this.desktopPane = E('div', { 'class': 'fwd-desktop', 'data-tab': 'desktop', 'data-tab-title': _('Desktop') }, [
				this.renderToolbar(),
				this.canvasWrap
			]),
			E('div', { 'data-tab': 'connections', 'data-tab-title': _('Connections') }, [ this.connPane ]),
			E('div', { 'data-tab': 'objects', 'data-tab-title': _('Objects') }, [ this.objPane ]),
			E('div', { 'data-tab': 'services', 'data-tab-title': _('Services') }, [ this.svcPane ]),
			E('div', { 'data-tab': 'preview', 'data-tab-title': _('Generated rules') }, [ this.previewPane ])
		]);

		this.root = E('div', { 'class': 'fwd-root' }, [
			E('h2', {}, [ _('Firewall Desktop') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Place hosts, networks and zones on the desktop and drag a line from the blue handle of one object to another to allow or block traffic between them. The firewall rules are generated from these connections; rules you created elsewhere are left untouched.')
			]),
			tabs
		]);

		ui.tabs.initTabGroup(tabs.childNodes);

		let wide = true;
		try { wide = localStorage.getItem('fwdesktop.wide') != '0'; } catch (e) {}
		this.setWide(wide);

		document.addEventListener('fullscreenchange', () => {
			if (!document.fullscreenElement && this.maximized)
				this.setMaximized(false);
		});

		document.addEventListener('keydown', ev => {
			if (ev.key == 'Escape' && this.maximized && !document.fullscreenElement &&
			    !document.body.classList.contains('modal-overlay-active'))
				this.setMaximized(false);
		});

		window.requestAnimationFrame(() => {
			this.updateBackground();
			this.fitView();
		});

		this.refresh();

		return this.root;
	},

	seedDefaults() {
		const m = this.model;
		m.objects.router = { id: 'router', type: 'router', label: _('This router'), zone: null, address: [], member: [], x: 400, y: 60, comment: '' };

		let i = 0;
		for (const z of this.zones) {
			const id = 'zone_' + z.replace(/[^A-Za-z0-9_]/g, '_');
			const isWan = /^wan/.test(z);
			m.objects[id] = {
				id: id, type: 'zone', zone: z,
				label: isWan ? _('Internet') : z.toUpperCase(),
				address: [], member: [], comment: '',
				x: isWan ? 700 : 100 + (i % 3) * 40,
				y: isWan ? 260 : 220 + (i++) * 110
			};
		}

		this.dirty = true;
	},

	updateBackground() {
		let el = this.canvasWrap, bg = null;
		while (el && el.nodeType == 1) {
			const c = window.getComputedStyle(el).backgroundColor;
			if (c && c != 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) {
				bg = c;
				break;
			}
			el = el.parentNode;
		}
		this.root.style.setProperty('--fwd-bg', bg || '#fff');
	},

	markDirty() {
		this.dirty = true;
		this.refresh();
	},

	refresh() {
		this.gen = fwm.generate(this.model);
		this.problems = {};
		for (const p of this.gen.problems)
			(this.problems[p.conn] = this.problems[p.conn] || []).push(p.msg);

		this.drawCanvas();
		this.renderConnections();
		this.renderObjects();
		this.renderServices();
		this.renderPreview();

		const n = this.gen.problems.length;
		dom.content(this.statusEl, [
			_('%d objects, %d connections, %d firewall sections').format(
				Object.keys(this.model.objects).length,
				Object.keys(this.model.connections).length,
				this.gen.sections.length),
			n ? E('span', { 'class': 'fwd-problem', 'style': 'margin-left:1em' }, [ _('Problems: %d').format(n) ]) : '',
			this.dirty ? E('em', { 'style': 'margin-left:1em' }, [ _('Unsaved changes, press "Save" or "Save & Apply"') ]) : ''
		]);
	},

	/* --- toolbar ------------------------------------------------------ */

	renderToolbar() {
		const btn = (title, cls, fn) => E('button', {
			'class': 'cbi-button ' + (cls || ''),
			'click': ui.createHandlerFn(this, fn)
		}, [ title ]);

		return E('div', { 'class': 'fwd-toolbar' }, [
			btn(_('+ Host'), 'cbi-button-add', () => this.editObject(null, 'host')),
			btn(_('+ Network'), 'cbi-button-add', () => this.editObject(null, 'network')),
			btn(_('+ Group'), 'cbi-button-add', () => this.editObject(null, 'group')),
			btn(_('+ Zone'), 'cbi-button-add', () => this.editObject(null, 'zone')),
			btn(_('+ IP set'), 'cbi-button-add', () => this.editObject(null, 'ipset')),
			E('span', { 'class': 'fwd-sep' }),
			btn(_('+ Service'), '', () => this.editService(null)),
			btn(_('Import rules…'), '', () => this.importDialog()),
			E('span', { 'class': 'fwd-sep' }),
			btn('−', '', () => this.zoomBy(1 / 1.2)),
			btn('+', '', () => this.zoomBy(1.2)),
			btn(_('Fit'), '', () => this.fitView()),
			E('span', { 'class': 'fwd-sep' }),
			this.policyBtn = btn(_('Zone policies'), this.showPolicies ? 'active' : '', () => this.setShowPolicies(!this.showPolicies)),
			this.wideBtn = btn(_('Wide layout'), '', () => this.setWide(!this.wide)),
			this.maxBtn = btn(_('Fullscreen'), '', () => this.setMaximized(!this.maximized)),
			E('span', { 'class': 'fwd-spacer' }),
			this.statusEl
		]);
	},

	/* --- layout ------------------------------------------------------- */

	setWide(on) {
		this.wide = on;
		document.body.classList.toggle('fwd-wide', on);

		/* inline styles as well, so the theme's fixed width is lifted even if the
		   stylesheet is stale or the theme uses stronger selectors */
		const mc = document.getElementById('maincontent');
		if (mc) {
			for (const [ k, v ] of [ [ 'max-width', 'none' ], [ 'width', 'auto' ], [ 'margin-left', '0' ], [ 'margin-right', '0' ] ]) {
				if (on) mc.style.setProperty(k, v, 'important');
				else mc.style.removeProperty(k);
			}
		}
		if (this.wideBtn)
			this.wideBtn.classList.toggle('active', on);
		try { localStorage.setItem('fwdesktop.wide', on ? '1' : '0'); } catch (e) {}
		window.requestAnimationFrame(() => this.fitView());
	},

	setMaximized(on) {
		this.maximized = on;
		document.body.classList.toggle('fwd-max', on);
		this.maxBtn.classList.toggle('active', on);
		this.maxBtn.textContent = on ? _('Exit fullscreen') : _('Fullscreen');

		/* browser fullscreen on the whole document, so LuCI dialogs stay visible */
		if (on && document.fullscreenEnabled && !document.fullscreenElement)
			document.documentElement.requestFullscreen().catch(() => {});
		else if (!on && document.fullscreenElement)
			document.exitFullscreen().catch(() => {});

		window.requestAnimationFrame(() => this.fitView());
	},

	/* --- canvas ------------------------------------------------------- */

	buildCanvas() {
		const markers = [ 'ACCEPT', 'REJECT', 'DROP', 'MIXED', 'policy', 'disabled' ].map(c => S('marker', {
			'id': 'fwd-arrow-' + c, 'viewBox': '0 0 10 10', 'refX': '9', 'refY': '5',
			'markerWidth': '7', 'markerHeight': '7', 'orient': 'auto-start-reverse',
			'markerUnits': 'strokeWidth'
		}, [ S('path', { 'd': 'M0,0 L10,5 L0,10 z', 'class': 'fwd-marker-' + c }) ]));

		const grid = S('pattern', { 'id': 'fwd-grid', 'width': GRID * 3, 'height': GRID * 3, 'patternUnits': 'userSpaceOnUse' }, [
			S('path', { 'd': 'M %d 0 L 0 0 0 %d'.format(GRID * 3, GRID * 3), 'class': 'fwd-grid-line', 'fill': 'none' })
		]);

		this.edgeLayer = S('g');
		this.nodeLayer = S('g');
		this.tempLayer = S('g');
		this.layer = S('g', {}, [
			S('rect', { 'x': -10000, 'y': -10000, 'width': 20000, 'height': 20000, 'fill': 'url(#fwd-grid)' }),
			this.edgeLayer, this.nodeLayer, this.tempLayer
		]);

		this.svg = S('svg', { 'class': 'fwd-canvas' }, [ S('defs', {}, markers.concat([ grid ])), this.layer ]);

		this.svg.addEventListener('pointerdown', ev => this.onPointerDown(ev));
		this.svg.addEventListener('pointermove', ev => this.onPointerMove(ev));
		this.svg.addEventListener('pointerup', ev => this.onPointerUp(ev));
		this.svg.addEventListener('pointercancel', ev => this.onPointerUp(ev));
		this.svg.addEventListener('dblclick', ev => this.onDoubleClick(ev));
		this.svg.addEventListener('pointerleave', () => this.hideTooltip());
		this.svg.addEventListener('wheel', ev => this.onWheel(ev), { passive: false });

		this.canvasWrap = E('div', {}, [
			this.canvasBox = E('div', { 'class': 'fwd-canvas-wrap' }, [ this.svg, this.tooltip = E('div', { 'class': 'fwd-tooltip' }) ]),
			E('div', { 'class': 'fwd-hint' }, [
				E('span', [ _('Drag objects to move them · drag from the blue dot to connect · double-click to edit · drag background to pan, wheel to zoom') ]),
				E('span', { 'class': 'fwd-legend' }, [
					E('span', { 'class': 'accept' }, [ ACTION_LABELS.ACCEPT ]),
					E('span', { 'class': 'reject' }, [ ACTION_LABELS.REJECT ]),
					E('span', { 'class': 'drop' }, [ ACTION_LABELS.DROP ]),
					E('span', { 'class': 'policy' }, [ _('Zone policy') ])
				])
			])
		]);

		document.addEventListener('keydown', ev => {
			if (ev.key != 'Delete' || !this.sel || document.body.classList.contains('modal-overlay-active'))
				return;
			if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName))
				return;
			if (this.sel.type == 'node')
				this.deleteObject(this.sel.id);
			else if (this.bundleMap[this.sel.id] && this.bundleMap[this.sel.id].conns.length == 1)
				this.deleteConnection(this.bundleMap[this.sel.id].conns[0].id, true);
			else
				this.openBundle(this.sel.id);
		});
	},

	applyPan() {
		this.layer.setAttribute('transform', 'translate(%f,%f) scale(%f)'.format(this.pan.x, this.pan.y, this.pan.k));
	},

	toWorld(ev) {
		const r = this.svg.getBoundingClientRect();
		return {
			x: (ev.clientX - r.left - this.pan.x) / this.pan.k,
			y: (ev.clientY - r.top - this.pan.y) / this.pan.k
		};
	},

	zoomBy(f, cx, cy) {
		const r = this.svg.getBoundingClientRect();
		if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
		const k = Math.min(2.5, Math.max(0.3, this.pan.k * f));
		this.pan.x = cx - (cx - this.pan.x) * (k / this.pan.k);
		this.pan.y = cy - (cy - this.pan.y) * (k / this.pan.k);
		this.pan.k = k;
		this.applyPan();
	},

	fitView() {
		const objs = Object.values(this.model.objects);
		const r = this.svg.getBoundingClientRect();
		if (!objs.length || !r.width) {
			this.applyPan();
			return;
		}
		const xs = objs.map(o => o.x), ys = objs.map(o => o.y);
		const minX = Math.min(...xs) - NODE_W / 2 - 60, maxX = Math.max(...xs) + NODE_W / 2 + 60;
		const minY = Math.min(...ys) - NODE_H / 2 - 90, maxY = Math.max(...ys) + NODE_H / 2 + 50;
		const k = Math.min(1.4, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
		this.pan = {
			k: k,
			x: (r.width - (maxX - minX) * k) / 2 - minX * k,
			y: (r.height - (maxY - minY) * k) / 2 - minY * k
		};
		this.applyPan();
	},

	fwSetNames() {
		return uci.sections('firewall', 'ipset').map(s => s.name).filter(Boolean);
	},

	objectSubtitle(o) {
		if (o.type != 'router' && o.type != 'group' && !this.zones.includes(o.zone))
			return '⚠ ' + _('unknown zone');

		switch (o.type) {
		case 'router':  return _('the router itself');
		case 'zone':    return _('all of zone %s').format(o.zone);
		case 'group':   return _('%d members').format(o.member.length);
		case 'ipset':
			if (!this.fwSetNames().includes(o.ipset))
				return '⚠ ' + _('unknown set %s').format(trunc(o.ipset, 10));
			return trunc(_('set %s').format(o.ipset) + ' · ' + o.zone, 24);
		default:
			return trunc(trunc(o.address[0] || '-', 18) + (o.address.length > 1 ? ' +' + (o.address.length - 1) : '') + ' · ' + o.zone, 24);
		}
	},

	drawCanvas() {
		const nodes = [];
		for (const id in this.model.objects) {
			const o = this.model.objects[id];
			const selected = this.sel && this.sel.type == 'node' && this.sel.id == id;
			const band = 'M8,0 H34 V%d H8 A8,8 0 0 1 0,%d V8 A8,8 0 0 1 8,0 Z'.format(NODE_H, NODE_H - 8);

			nodes.push(S('g', {
				'class': 'fwd-node fwd-type-' + o.type + (selected ? ' selected' : ''),
				'data-id': id,
				'transform': 'translate(%f,%f)'.format(o.x - NODE_W / 2, o.y - NODE_H / 2)
			}, [
				S('title', {}, [ TYPE_LABELS[o.type] + ': ' + o.label + (o.comment ? '\n' + o.comment : '') ]),
				S('rect', { 'class': 'fwd-box', 'width': NODE_W, 'height': NODE_H, 'rx': 8 }),
				S('path', { 'class': 'fwd-band', 'd': band }),
				S('path', { 'class': 'fwd-icon', 'd': ICONS[o.type], 'transform': 'translate(17,%d)'.format(NODE_H / 2) }),
				S('text', { 'class': 'fwd-title', 'x': 44, 'y': 24 }, [ trunc(o.label, 17) ]),
				S('text', { 'class': 'fwd-sub', 'x': 44, 'y': 42 }, [ this.objectSubtitle(o) ]),
				S('circle', { 'class': 'fwd-handle', 'cx': NODE_W, 'cy': NODE_H / 2, 'r': 7 })
			]));
		}

		dom.content(this.nodeLayer, nodes);
		this.drawEdges();
		this.applyPan();
	},

	/* all connections between the same two objects in the same direction share one line */
	bundles() {
		const b = {};
		for (const cid of fwm.connectionOrder(this.model)) {
			const c = this.model.connections[cid];
			if (!this.model.objects[c.src] || !this.model.objects[c.dest])
				continue;
			const key = c.src + '|' + c.dest;
			(b[key] = b[key] || { key: key, src: c.src, dest: c.dest, conns: [] }).conns.push(c);
		}
		return b;
	},

	edgeGeometry(bundles) {
		/* a->b and b->a bundles fan out from each other */
		const pairs = {};
		for (const key in bundles) {
			const bd = bundles[key];
			const pk = [ bd.src, bd.dest ].sort().join('|');
			(pairs[pk] = pairs[pk] || []).push(key);
		}

		const clip = (o, tx, ty, pad) => {
			const ddx = tx - o.x, ddy = ty - o.y;
			const s = Math.min(
				ddx ? (NODE_W / 2 + pad) / Math.abs(ddx) : Infinity,
				ddy ? (NODE_H / 2 + pad) / Math.abs(ddy) : Infinity);
			return [ o.x + ddx * Math.min(s, 1), o.y + ddy * Math.min(s, 1) ];
		};

		const geo = {};
		for (const pk in pairs) {
			const list = pairs[pk];
			list.forEach((key, i) => {
				const bd = bundles[key];
				const a = this.model.objects[bd.src], b = this.model.objects[bd.dest];

				if (a === b) {
					const h = 64, w = 36, x = a.x, y = a.y - NODE_H / 2;
					geo[key] = {
						d: 'M%f,%f C%f,%f %f,%f %f,%f'.format(x + w / 2, y, x + w, y - h, x - w, y - h, x - w / 2, y),
						mx: x, my: y - h * 0.75
					};
					return;
				}

				const off = (i - (list.length - 1) / 2);
				const [ p, q ] = (bd.src < bd.dest) ? [ a, b ] : [ b, a ];
				const dx = q.x - p.x, dy = q.y - p.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
				const nx = -dy / len, ny = dx / len;
				const bend = off * 56;
				const cx = (a.x + b.x) / 2 + nx * bend, cy = (a.y + b.y) / 2 + ny * bend;
				const [ sx, sy ] = clip(a, cx, cy, 2);
				const [ ex, ey ] = clip(b, cx, cy, 5);

				geo[key] = {
					d: 'M%f,%f Q%f,%f %f,%f'.format(sx, sy, cx, cy, ex, ey),
					mx: 0.25 * sx + 0.5 * cx + 0.25 * ex,
					my: 0.25 * sy + 0.5 * cy + 0.25 * ey
				};
			});
		}

		return geo;
	},

	connServices(c) {
		return c.service.length ? c.service.map(id => fwm.serviceLabel(this.model, id)) : [ _('Any') ];
	},

	edgeLabel(c) {
		let s = this.connServices(c).join(', ');
		if (c.nat == 'masq') s = 'NAT · ' + s;
		if (c.nat == 'dnat') s = _('Forward') + ' · ' + s;
		return s;
	},

	bundleLabel(bd) {
		if (bd.conns.length == 1)
			return trunc(this.edgeLabel(bd.conns[0]), 30);
		const svcs = [];
		for (const c of bd.conns)
			for (const l of this.connServices(c))
				if (!svcs.includes(l)) svcs.push(l);
		return trunc('%d × · %s'.format(bd.conns.length, svcs.join(', ')), 30);
	},

	bundleClass(bd) {
		const active = bd.conns.filter(c => c.enabled);
		if (!active.length)
			return 'disabled';
		const acts = active.map(c => c.action).filter((a, i, l) => l.indexOf(a) == i);
		return acts.length == 1 ? acts[0] : 'MIXED';
	},

	/* zone forwardings and "input ACCEPT" zone policies, drawn as dashed lines */
	policyBundles() {
		const out = {};
		const zoneObj = z => Object.values(this.model.objects).filter(o => o.type == 'zone' && o.zone == z)[0];
		const router = Object.values(this.model.objects).filter(o => o.type == 'router')[0];
		const zoneSec = z => uci.sections('firewall', 'zone').filter(s => s.name == z)[0] || {};
		const add = (so, dob, policy) => {
			const key = 'policy:' + so.id + '|' + dob.id;
			if (!out[key])
				out[key] = { key: key, src: so.id, dest: dob.id, conns: [], policy: policy };
		};

		for (const f of uci.sections('firewall', 'forwarding')) {
			if (f.enabled == '0' || !f.src || !f.dest)
				continue;
			const so = zoneObj(f.src), dob = zoneObj(f.dest);
			if (so && dob)
				add(so, dob, { kind: 'forward', src: f.src, dest: f.dest, masq: zoneSec(f.dest).masq == '1' });
		}

		if (router)
			for (const z of uci.sections('firewall', 'zone')) {
				const so = zoneObj(z.name);
				if (so && String(z.input || '').toUpperCase() == 'ACCEPT')
					add(so, router, { kind: 'input', src: z.name });
			}

		return out;
	},

	policyLabel(p) {
		return p.kind == 'forward'
			? _('zone forwarding') + (p.masq ? ' · NAT' : '')
			: _('zone policy: accept all');
	},

	drawEdges() {
		this.bundleMap = this.bundles();
		if (this.showPolicies)
			Object.assign(this.bundleMap, this.policyBundles());
		const geo = this.edgeGeometry(this.bundleMap);
		const selNode = (this.sel && this.sel.type == 'node') ? this.sel.id : null;
		const edges = [];

		for (const key in geo) {
			const bd = this.bundleMap[key];
			const g = geo[key];

			if (bd.policy) {
				const label = this.policyLabel(bd.policy);
				const w = label.length * 6.1 + 16;
				edges.push(S('g', {
					'class': 'fwd-edge policy' + ((selNode && bd.src != selNode && bd.dest != selNode) ? ' dimmed' : ''),
					'data-bundle': key
				}, [
					S('path', { 'class': 'fwd-hit', 'd': g.d }),
					S('path', { 'class': 'fwd-line', 'd': g.d, 'marker-end': 'url(#fwd-arrow-policy)' }),
					S('rect', { 'class': 'fwd-badge', 'x': g.mx - w / 2, 'y': g.my - 10, 'width': w, 'height': 20, 'rx': 10 }),
					S('text', { 'class': 'fwd-badge-text', 'x': g.mx, 'y': g.my + 4, 'text-anchor': 'middle' }, [ label ])
				]));
				continue;
			}

			const cls = this.bundleClass(bd);
			const label = this.bundleLabel(bd);
			const w = label.length * 6.1 + 16;
			const prob = bd.conns.some(c => this.problems && this.problems[c.id]);
			const selected = this.sel && this.sel.type == 'edge' && this.sel.id == key;

			edges.push(S('g', {
				'class': 'fwd-edge ' + cls + (cls == 'disabled' ? ' disabled' : '') + (prob ? ' problem' : '') +
					(selected ? ' selected' : '') +
					((selNode && bd.src != selNode && bd.dest != selNode) ? ' dimmed' : ''),
				'data-bundle': key
			}, [
				S('path', { 'class': 'fwd-hit', 'd': g.d }),
				S('path', { 'class': 'fwd-line', 'd': g.d, 'marker-end': 'url(#fwd-arrow-' + cls + ')' }),
				S('rect', { 'class': 'fwd-badge', 'x': g.mx - w / 2, 'y': g.my - 10, 'width': w, 'height': 20, 'rx': 10 }),
				S('text', { 'class': 'fwd-badge-text', 'x': g.mx, 'y': g.my + 4, 'text-anchor': 'middle' }, [ (prob ? '⚠ ' : '') + label ])
			]));
		}

		dom.content(this.edgeLayer, edges);
	},

	/* hover card listing every connection of a line */
	showTooltip(ev, key) {
		const bd = this.bundleMap && this.bundleMap[key];
		if (!bd) return this.hideTooltip();

		if (this.tipKey != key && bd.policy) {
			this.tipKey = key;
			const so = this.model.objects[bd.src], dob = this.model.objects[bd.dest];
			dom.content(this.tooltip, [
				E('div', { 'class': 'fwd-tip-title' }, [ '%s → %s'.format(so.label, dob.label) ]),
				E('div', [ bd.policy.kind == 'forward'
					? _('Zone forwarding %s → %s: all traffic is allowed unless a connection blocks it first.').format(bd.policy.src, bd.policy.dest)
					: _('Zone %s has input policy ACCEPT: every service on the router is reachable unless a connection blocks it first.').format(bd.policy.src) ]),
				bd.policy.masq ? E('div', [ _('Masquerading is enabled on zone %s.').format(bd.policy.dest) ]) : '',
				E('div', { 'class': 'fwd-tip-sub' }, [ _('Set in Network → Firewall → General Settings. Click for details.') ])
			]);
		}
		else if (this.tipKey != key) {
			this.tipKey = key;
			const so = this.model.objects[bd.src], dob = this.model.objects[bd.dest];
			dom.content(this.tooltip, [
				E('div', { 'class': 'fwd-tip-title' }, [ '%s → %s'.format(so.label, dob.label) ]),
				E('table', {}, bd.conns.map(c => E('tr', { 'class': c.enabled ? '' : 'disabled' }, [
					E('td', {}, [ E('span', { 'class': 'fwd-pill ' + c.action }, [ ACTION_LABELS[c.action] ]) ]),
					E('td', {}, [
						this.connServices(c).join(', '),
						c.nat == 'masq' ? E('em', [ ' · NAT' ]) : '',
						c.nat == 'dnat' ? E('em', [ ' · ' + _('port forward') + (c.ext_port ? ' ' + c.ext_port : '') ]) : '',
						c.family ? E('em', [ ' · ' + (c.family == 'ipv4' ? 'IPv4' : 'IPv6') ]) : '',
						c.enabled ? '' : E('em', [ ' · ' + _('disabled') ]),
						c.label ? E('div', { 'class': 'fwd-tip-sub' }, [ c.label ]) : '',
						...((this.problems[c.id] || []).map(p => E('div', { 'class': 'fwd-problem' }, [ p ])))
					])
				]))),
				E('div', { 'class': 'fwd-tip-sub' }, [ bd.conns.length > 1 ? _('Click to manage these connections') : _('Click to edit') ])
			]);
		}

		const r = this.canvasBox.getBoundingClientRect();
		const tw = this.tooltip.offsetWidth || 260, th = this.tooltip.offsetHeight || 80;
		let x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 16;
		if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 12;
		if (y + th > r.height - 8) y = Math.max(8, ev.clientY - r.top - th - 12);
		this.tooltip.style.left = x + 'px';
		this.tooltip.style.top = y + 'px';
		this.tooltip.classList.add('visible');
	},

	hideTooltip() {
		this.tipKey = null;
		if (this.tooltip)
			this.tooltip.classList.remove('visible');
	},

	/* toggle selection classes without re-rendering, so double clicks keep their target */
	updateSelection() {
		const sel = this.sel || {};
		this.nodeLayer.querySelectorAll('.fwd-node').forEach(n =>
			n.classList.toggle('selected', sel.type == 'node' && n.getAttribute('data-id') == sel.id));
		this.edgeLayer.querySelectorAll('.fwd-edge').forEach(e => {
			const bd = this.bundleMap[e.getAttribute('data-bundle')];
			e.classList.toggle('selected', sel.type == 'edge' && bd.key == sel.id);
			e.classList.toggle('dimmed', sel.type == 'node' && bd.src != sel.id && bd.dest != sel.id);
		});
	},

	openBundle(key) {
		const bd = this.bundleMap && this.bundleMap[key];
		if (!bd) return;
		if (bd.policy)
			return this.policyDialog(bd);
		if (bd.conns.length == 1)
			this.editConnection(bd.conns[0].id);
		else
			this.bundleDialog(bd.src, bd.dest);
	},

	policyDialog(bd) {
		const so = this.model.objects[bd.src], dob = this.model.objects[bd.dest];
		const p = bd.policy;
		ui.showModal('%s → %s'.format(so.label, dob.label), [
			E('p', [ p.kind == 'forward'
				? _('This line is not a connection made on the desktop. It comes from the zone forwarding "%s → %s" in the firewall zone settings, which allows all traffic from zone %s to zone %s.').format(p.src, p.dest, p.src, p.dest)
				: _('This line is not a connection made on the desktop. Zone "%s" has the input policy ACCEPT, so devices in it can reach every service on the router.').format(p.src) ]),
			E('p', [ _('Connections drawn on the desktop are evaluated first, so you can still block specific traffic here. To allow only what you draw, remove the forwarding or set the policy to REJECT/DROP in the zone settings, then add connections for the traffic you want.') ]),
			p.masq ? E('p', [ _('Masquerading (NAT) is enabled on zone %s.').format(p.dest) ]) : '',
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button cbi-button-add fwd-left', 'click': () => { ui.hideModal(); this.editConnection(null, { src: bd.src, dest: bd.dest }); } }, [ _('+ Add connection') ]),
				E('a', { 'class': 'cbi-button cbi-button-action', 'href': L.url('admin/network/firewall/zones') }, [ _('Open zone settings') ]),
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Close') ])
			])
		]);
	},

	setShowPolicies(on) {
		this.showPolicies = on;
		if (this.policyBtn)
			this.policyBtn.classList.toggle('active', on);
		try { localStorage.setItem('fwdesktop.policies', on ? '1' : '0'); } catch (e) {}
		if (this.edgeLayer)
			this.drawEdges();
	},

	/* --- pointer interaction ------------------------------------------ */

	onPointerDown(ev) {
		if (ev.button != 0)
			return;

		const t = ev.target;
		const handle = t.closest('.fwd-handle');
		const node = t.closest('.fwd-node');
		const edge = t.closest('.fwd-edge');
		const p = this.toWorld(ev);

		if (handle && node) {
			const o = this.model.objects[node.getAttribute('data-id')];
			this.drag = { mode: 'connect', id: o.id, sx: o.x + NODE_W / 2, sy: o.y, line: S('path', { 'class': 'fwd-temp-line' }) };
			this.tempLayer.appendChild(this.drag.line);
		}
		else if (node) {
			const o = this.model.objects[node.getAttribute('data-id')];
			this.drag = { mode: 'move', id: o.id, el: node, dx: p.x - o.x, dy: p.y - o.y, cx: ev.clientX, cy: ev.clientY, moved: false };
		}
		else if (edge) {
			this.drag = { mode: 'edge', id: edge.getAttribute('data-bundle'), cx: ev.clientX, cy: ev.clientY };
			this.hideTooltip();
		}
		else {
			this.drag = { mode: 'pan', cx: ev.clientX, cy: ev.clientY, px: this.pan.x, py: this.pan.y, moved: false };
			this.svg.classList.add('fwd-panning');
		}

		this.svg.setPointerCapture(ev.pointerId);
		ev.preventDefault();
	},

	onPointerMove(ev) {
		const d = this.drag;
		if (!d) {
			const hit = ev.target.closest ? ev.target.closest('.fwd-edge') : null;
			if (hit)
				this.showTooltip(ev, hit.getAttribute('data-bundle'));
			else if (this.tipKey)
				this.hideTooltip();
			return;
		}

		const p = this.toWorld(ev);

		switch (d.mode) {
		case 'move':
			if (!d.moved && Math.abs(ev.clientX - d.cx) + Math.abs(ev.clientY - d.cy) < 4)
				return;
			d.moved = true;
			const o = this.model.objects[d.id];
			o.x = snap(p.x - d.dx);
			o.y = snap(p.y - d.dy);
			d.el.setAttribute('transform', 'translate(%f,%f)'.format(o.x - NODE_W / 2, o.y - NODE_H / 2));
			this.drawEdges();
			break;

		case 'connect':
			d.line.setAttribute('d', 'M%f,%f L%f,%f'.format(d.sx, d.sy, p.x, p.y));
			const hit = document.elementFromPoint(ev.clientX, ev.clientY);
			const target = hit && hit.closest ? hit.closest('.fwd-node') : null;
			this.nodeLayer.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
			if (target)
				target.classList.add('drop-target');
			d.target = target ? target.getAttribute('data-id') : null;
			break;

		case 'pan':
			d.moved = d.moved || Math.abs(ev.clientX - d.cx) + Math.abs(ev.clientY - d.cy) > 3;
			this.pan.x = d.px + ev.clientX - d.cx;
			this.pan.y = d.py + ev.clientY - d.cy;
			this.applyPan();
			break;
		}
	},

	onPointerUp(ev) {
		const d = this.drag;
		if (!d)
			return;

		this.drag = null;
		this.svg.classList.remove('fwd-panning');

		switch (d.mode) {
		case 'move':
			if (d.moved) {
				this.markDirty();
			}
			else {
				this.sel = { type: 'node', id: d.id };
				this.updateSelection();
			}
			break;

		case 'connect':
			dom.content(this.tempLayer, []);
			this.nodeLayer.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
			if (d.target && ev.type == 'pointerup')
				this.editConnection(null, { src: d.id, dest: d.target });
			break;

		case 'edge':
			if (Math.abs(ev.clientX - d.cx) + Math.abs(ev.clientY - d.cy) < 4) {
				this.sel = { type: 'edge', id: d.id };
				this.updateSelection();
				this.openBundle(d.id);
			}
			break;

		case 'pan':
			if (!d.moved && this.sel) {
				this.sel = null;
				this.updateSelection();
			}
			break;
		}
	},

	onDoubleClick(ev) {
		/* pointer capture retargets click events to the svg, so look up what is under the cursor */
		const t = document.elementFromPoint(ev.clientX, ev.clientY) || ev.target;
		const node = t.closest ? t.closest('.fwd-node') : null;
		if (node && !t.closest('.fwd-handle'))
			this.editObject(node.getAttribute('data-id'));
	},

	onWheel(ev) {
		ev.preventDefault();
		const r = this.svg.getBoundingClientRect();
		this.zoomBy(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
	},

	/* --- form helpers ------------------------------------------------- */

	formRow(label, widget, description, name) {
		const node = widget.render ? widget.render() : widget;
		return E('div', { 'class': 'fwd-row', 'data-name': name || '' }, [
			E('label', {}, [ label ]),
			E('div', { 'class': 'fwd-field' }, [
				node,
				description ? E('div', { 'class': 'cbi-value-description' }, [ description ]) : ''
			])
		]);
	},

	dialogButtons(onDelete, onSave, onCancel) {
		return E('div', { 'class': 'fwd-dialog-buttons' }, [
			onDelete ? E('button', { 'class': 'cbi-button cbi-button-negative fwd-left', 'click': onDelete }, [ _('Delete') ]) : '',
			E('button', { 'class': 'cbi-button', 'click': onCancel || ui.hideModal }, [ _('Cancel') ]),
			E('button', { 'class': 'cbi-button cbi-button-positive', 'click': onSave }, [ _('Apply') ])
		]);
	},

	showRow(form, name, show) {
		const row = form.querySelector('.fwd-row[data-name="%s"]'.format(name));
		if (row)
			row.classList.toggle('hidden', !show);
	},

	zoneChoices() {
		const c = {};
		for (const z of this.zones)
			c[z] = z;
		return c;
	},

	zoneForAddress(addr) {
		const ip = ip4ToInt(String(addr).split('/')[0].split('-')[0]);
		if (ip == null)
			return null;

		for (const zs of uci.sections('firewall', 'zone')) {
			const nets = fwm.toList(zs.network);
			for (const ifc of this.ifaces) {
				if (!nets.includes(ifc.interface))
					continue;
				for (const a of (ifc['ipv4-address'] || [])) {
					const net = ip4ToInt(a.address), mask = a.mask ? (~0 << (32 - a.mask)) >>> 0 : 0;
					if (net != null && ((ip & mask) >>> 0) == ((net & mask) >>> 0))
						return zs.name;
				}
			}
		}
		return null;
	},

	hostChoices() {
		const c = {};
		for (const mac in this.hints) {
			const h = this.hints[mac];
			for (const ip of (h.ipaddrs || []).concat(h.ip6addrs || []))
				c[ip] = h.name ? '%s (%s)'.format(ip, h.name) : ip;
		}
		return c;
	},

	/* --- object editor ------------------------------------------------ */

	editObject(id, type) {
		const isNew = !id;
		const o = isNew ? {
			id: fwm.randomId('o', this.model.objects), type: type, label: '', zone: null,
			address: [], member: [], comment: '', x: 0, y: 0
		} : clone(this.model.objects[id]);

		const wLabel = new ui.Textfield(o.label, { optional: o.type == 'ipset', placeholder: o.type == 'ipset' ? _('same as the set name') : TYPE_LABELS[o.type] });
		const wZone = new ui.Select(o.zone || (o.type == 'zone' ? null : this.zones[0]), this.zoneChoices(), { optional: false });
		let zoneTouched = !isNew;
		const wAddr = new ui.DynamicList(o.address, (o.type == 'host') ? this.hostChoices() : {}, {
			datatype: o.type == 'host' ? 'ipaddr(1)' : 'or(cidr,iprange,ipaddr(1))',
			optional: false
		});
		const memberChoices = {};
		for (const mid in this.model.objects) {
			const m = this.model.objects[mid];
			if (mid != o.id && m.type != 'router')
				memberChoices[mid] = '%s (%s)'.format(m.label, TYPE_LABELS[m.type]);
		}
		const wMembers = new ui.Dropdown(o.member, memberChoices, { multiple: true, optional: false, display_items: 6, dropdown_items: 10 });
		const wComment = new ui.Textfield(o.comment, { optional: true });
		const setChoices = {};
		for (const st of uci.sections('firewall', 'ipset')) {
			if (!st.name) continue;
			const info = [ st.family || 'ipv4' ].concat(fwm.toList(st.match)).join(', ');
			const n = fwm.toList(st.entry).length;
			setChoices[st.name] = '%s (%s%s)'.format(st.name, info, st.loadfile ? ', ' + _('from file') : (n ? ', ' + _('%d entries').format(n) : ''));
		}
		if (o.ipset && !setChoices[o.ipset])
			setChoices[o.ipset] = o.ipset + ' (' + _('not defined') + ')';
		const wSet = new ui.Select(o.ipset || null, setChoices, { optional: false, sort: true });

		const rows = [ this.formRow(_('Name'), wLabel) ];

		if (o.type == 'host' || o.type == 'network' || o.type == 'zone' || o.type == 'ipset')
			rows.push(this.formRow(_('Zone'), wZone,
				o.type == 'zone' ? _('Represents every address in this firewall zone. Use it for "the Internet" (wan) or a whole LAN.')
				                 : _('The firewall zone this object lives in.')));

		if (o.type == 'host')
			rows.push(this.formRow(_('IP addresses'), wAddr, _('One or more addresses of this host (IPv4 and/or IPv6).')));
		else if (o.type == 'network')
			rows.push(this.formRow(_('Networks'), wAddr, _('Subnets (192.168.10.0/24), ranges (10.0.0.10-10.0.0.20) or single addresses.')));
		else if (o.type == 'group')
			rows.push(this.formRow(_('Members'), wMembers, _('Hosts, networks and zones in this group. Members may be in different zones.')));
		else if (o.type == 'ipset')
			rows.push(this.formRow(_('IP set'), wSet, Object.keys(setChoices).length
				? _('An fw4 IP set (Network → Firewall → IP Sets). Its entries can change without touching the rules, e.g. block lists or sets filled by dnsmasq.')
				: _('No IP sets are defined yet. Create one under Network → Firewall → IP Sets first.')));

		rows.push(this.formRow(_('Comment'), wComment));

		const form = E('div', { 'class': 'fwd-form' }, rows);

		form.addEventListener('widget-change', ev => {
			if (wZone.node && wZone.node.contains(ev.target))
				zoneTouched = true;
			if (!zoneTouched && (o.type == 'host' || o.type == 'network')) {
				const z = this.zoneForAddress(wAddr.getValue()[0]);
				if (z) wZone.setValue(z);
			}
		});

		const save = () => {
			const widgets = [ wLabel ];
			if (o.type == 'host' || o.type == 'network') widgets.push(wAddr);
			if (o.type == 'group') widgets.push(wMembers);
			for (const w of widgets)
				w.triggerValidation && w.triggerValidation();

			const label = wLabel.getValue().trim();
			if ((!label && o.type != 'ipset') || widgets.some(w => w.isValid && !w.isValid()))
				return ui.addNotification(null, E('p', [ _('Please correct the highlighted fields.') ]), 'warning');

			o.label = label;
			o.comment = wComment.getValue().trim();
			if (o.type == 'ipset') {
				o.ipset = wSet.getValue();
				if (!o.ipset)
					return ui.addNotification(null, E('p', [ _('Please choose an IP set.') ]), 'warning');
				if (!label)
					o.label = o.ipset;
			}
			if (o.type == 'host' || o.type == 'network' || o.type == 'zone' || o.type == 'ipset') {
				o.zone = wZone.getValue();
				if (!o.zone)
					return ui.addNotification(null, E('p', [ _('Please choose a zone.') ]), 'warning');
			}
			if (o.type == 'host' || o.type == 'network') {
				o.address = fwm.toList(wAddr.getValue());
				if (!o.address.length)
					return ui.addNotification(null, E('p', [ _('Please enter at least one address.') ]), 'warning');
			}
			if (o.type == 'group')
				o.member = fwm.toList(wMembers.getValue());

			if (isNew) {
				const r = this.svg.getBoundingClientRect();
				const n = Object.keys(this.model.objects).length;
				o.x = snap(((r.width || 600) / 2 - this.pan.x) / this.pan.k + (n % 5) * 16);
				o.y = snap(((r.height || 400) / 2 - this.pan.y) / this.pan.k + (n % 5) * 16);
			}

			this.model.objects[o.id] = o;
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal((isNew ? _('New %s') : _('Edit %s')).format(TYPE_LABELS[o.type].toLowerCase()), [
			form,
			this.dialogButtons((isNew || o.type == 'router') ? null : () => { ui.hideModal(); this.deleteObject(o.id); }, save)
		]);
	},

	deleteObject(id) {
		const o = this.model.objects[id];
		if (!o || o.type == 'router')
			return;

		const conns = Object.values(this.model.connections).filter(c => c.src == id || c.dest == id);
		const groups = Object.values(this.model.objects).filter(g => g.type == 'group' && g.member.includes(id));

		const doDelete = () => {
			for (const c of conns)
				delete this.model.connections[c.id];
			for (const g of groups)
				g.member = g.member.filter(m => m != id);
			delete this.model.objects[id];
			this.sel = null;
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(_('Delete object'), [
			E('p', [ _('Delete "%s"?').format(o.label) ]),
			conns.length ? E('p', [ _('This also deletes %d connection(s) using it.').format(conns.length) ]) : '',
			groups.length ? E('p', [ _('It will be removed from %d group(s).').format(groups.length) ]) : '',
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': doDelete }, [ _('Delete') ])
			])
		]);
	},

	/* --- connection editor -------------------------------------------- */

	serviceChoices(excludeId) {
		const c = {};
		const svcs = fwm.allServices(this.model);
		for (const id in svcs)
			if (id != excludeId)
				c[id] = '%s (%s)'.format(svcs[id].label, fwm.describeService(svcs[id]));
		return c;
	},

	editConnection(id, preset, onDone) {
		const isNew = !id;
		const c = isNew ? Object.assign({
			id: fwm.randomId('c', this.model.connections), src: null, dest: null, service: [],
			action: 'ACCEPT', nat: 'none', ext_port: '', family: '', fwopt: [], log: false, enabled: true, label: '', comment: ''
		}, preset || {}) : clone(this.model.connections[id]);

		if (isNew) {
			const so = this.model.objects[c.src], dob = this.model.objects[c.dest];
			/* sensible default: LAN -> Internet gets masquerading like stock OpenWrt */
			const zs = dob && dob.zone ? uci.sections('firewall', 'zone').filter(z => z.name == dob.zone)[0] : null;
			if (so && dob && so.type != 'router' && dob.type != 'router' && /^wan/.test(dob.zone || '') && zs && zs.masq != '1')
				c.nat = 'masq';
		}

		const objChoices = {};
		for (const oid in this.model.objects)
			objChoices[oid] = '%s (%s)'.format(this.model.objects[oid].label, TYPE_LABELS[this.model.objects[oid].type]);

		const wLabel = new ui.Textfield(c.label, { optional: true, placeholder: _('automatic') });
		const wSrc = new ui.Select(c.src, objChoices, { optional: false, sort: true });
		const wDest = new ui.Select(c.dest, objChoices, { optional: false, sort: true });
		const wSvc = new ui.Dropdown(c.service, this.serviceChoices(), {
			multiple: true, optional: false, placeholder: _('-- choose services --'), display_items: 5, dropdown_items: 12, sort: false
		});
		const wAction = new ui.Select(c.action, ACTION_LABELS, { optional: false, sort: false });
		const wNat = new ui.Select(c.nat, {
			none: _('None'),
			masq: _('Masquerade (hide source behind the router address)'),
			dnat: _('Port forwarding (publish target host on the router)')
		}, { optional: false, sort: false });
		const wExt = new ui.Textfield(c.ext_port, { optional: true, datatype: 'list(portrange)', placeholder: _('same as service port') });
		const wLog = new ui.Checkbox(c.log ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wEnabled = new ui.Checkbox(c.enabled ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wComment = new ui.Textfield(c.comment, { optional: true });
		const wFamily = new ui.Select(c.family || '', { '': _('IPv4 and IPv6'), ipv4: _('IPv4 only'), ipv6: _('IPv6 only') }, { optional: false, sort: false });
		const optChoices = {};
		for (const k of fwm.PASSTHROUGH_OPTS) optChoices[k + '='] = k + '=…';
		const wOpts = new ui.DynamicList(c.fwopt || [], optChoices, { optional: true });
		const preview = E('div', { 'class': 'fwd-preview' });
		const problems = E('div');

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('From'), wSrc),
			this.formRow(_('To'), wDest),
			this.formRow(_('Services'), wSvc, _('Traffic matching any of these services is handled by this connection. Replies are allowed automatically.')),
			this.formRow(_('Action'), wAction),
			this.formRow(_('NAT'), wNat, null, 'nat'),
			this.formRow(_('Public ports'), wExt, _('Optional, one port per service port, in the same order. Leave empty to use the same port numbers.'), 'ext'),
			this.formRow(_('IP family'), wFamily),
			this.formRow(_('Log matches'), wLog),
			this.formRow(_('Enabled'), wEnabled),
			this.formRow(_('Name'), wLabel),
			this.formRow(_('Comment'), wComment),
			this.formRow(_('Extra fw4 options'), wOpts, _('Advanced: additional fw4 options as key=value, e.g. limit=10/sec or start_time=08:00. Allowed: %s').format(fwm.PASSTHROUGH_OPTS.join(', '))),
			E('h5', { 'style': 'margin-top:1em' }, [ _('Resulting firewall configuration') ]),
			problems,
			preview
		]);

		const read = () => {
			c.label = wLabel.getValue().trim();
			c.src = wSrc.getValue();
			c.dest = wDest.getValue();
			c.service = fwm.toList(wSvc.getValue());
			c.action = wAction.getValue() || 'ACCEPT';
			c.nat = wNat.getValue() || 'none';
			c.ext_port = c.nat == 'dnat' ? wExt.getValue().trim() : '';
			c.log = wLog.getValue() == '1';
			c.enabled = wEnabled.getValue() == '1';
			c.comment = wComment.getValue().trim();
			c.family = wFamily.getValue() || '';
			c.fwopt = fwm.toList(wOpts.getValue()).filter(kv => FWOPT_RE.test(kv));
		};

		const update = () => {
			read();
			this.showRow(form, 'nat', c.action == 'ACCEPT');
			if (c.action != 'ACCEPT') c.nat = 'none';
			this.showRow(form, 'ext', c.nat == 'dnat');

			const m = Object.assign({}, this.model, { connections: {}, order: [ c.id ] });
			m.connections[c.id] = Object.assign({}, c, { enabled: true });
			const g = fwm.generate(m);
			dom.content(problems, g.problems.map(p => E('div', { 'class': 'fwd-problem' }, [ p.msg ])));
			preview.textContent = g.sections.length ? this.uciText(g.sections) : _('(nothing)');
		};

		form.addEventListener('widget-change', update);
		form.addEventListener('input', update);
		form.addEventListener('change', update);

		const save = () => {
			read();
			if (c.action != 'ACCEPT') c.nat = 'none';
			if (!c.src || !c.dest)
				return ui.addNotification(null, E('p', [ _('Please choose source and destination.') ]), 'warning');
			if (!c.service.length)
				return ui.addNotification(null, E('p', [ _('Please choose at least one service ("Any" allows everything).') ]), 'warning');
			if (c.nat == 'dnat' && wExt.isValid && !wExt.isValid())
				return ui.addNotification(null, E('p', [ _('Invalid public port.') ]), 'warning');

			this.model.connections[c.id] = c;
			if (isNew)
				this.model.order.push(c.id);
			ui.hideModal();
			this.sel = { type: 'edge', id: c.src + '|' + c.dest };
			this.markDirty();
			if (onDone) onDone();
		};

		ui.showModal(isNew ? _('New connection') : _('Edit connection'), [
			form,
			this.dialogButtons(isNew ? null : () => { ui.hideModal(); this.deleteConnection(c.id, !onDone, onDone); }, save,
				onDone ? () => { ui.hideModal(); onDone(); } : null)
		], 'cbi-modal');

		update();
	},

	deleteConnection(id, confirmFirst, onDone) {
		const doDelete = () => {
			delete this.model.connections[id];
			this.model.order = this.model.order.filter(x => x != id);
			this.sel = null;
			ui.hideModal();
			this.markDirty();
			if (onDone) onDone();
		};

		if (!confirmFirst)
			return doDelete();

		ui.showModal(_('Delete connection'), [
			E('p', [ _('Delete the selected connection?') ]),
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': doDelete }, [ _('Delete') ])
			])
		]);
	},

	/* one dialog for every connection between two objects (one direction) */
	bundleDialog(src, dest) {
		const reopen = () => {
			const bd = this.bundles()[src + '|' + dest];
			if (bd && bd.conns.length > 1)
				this.bundleDialog(src, dest);
		};
		const bd = this.bundles()[src + '|' + dest];
		if (!bd) return;

		const order = fwm.connectionOrder(this.model);
		const so = this.model.objects[src], dob = this.model.objects[dest];
		const btn = (title, cls, fn) => E('button', { 'class': 'cbi-button ' + cls, 'click': fn }, [ title ]);

		const rows = bd.conns.map(c => {
			const prob = this.problems[c.id];
			return E('tr', { 'class': 'tr' + (c.enabled ? '' : ' disabled') }, [
				E('td', { 'class': 'td' }, [ String(order.indexOf(c.id) + 1) ]),
				E('td', { 'class': 'td' }, this.connServices(c).map(l => E('span', { 'class': 'fwd-pill' }, [ l ]))),
				E('td', { 'class': 'td' }, [ E('span', { 'class': 'fwd-pill ' + c.action }, [ ACTION_LABELS[c.action] ]) ]),
				E('td', { 'class': 'td' }, [
					[ { none: '', masq: _('Masquerade'), dnat: _('Port forward') + (c.ext_port ? ' ' + c.ext_port : '') }[c.nat],
					  c.family ? (c.family == 'ipv4' ? 'IPv4' : 'IPv6') : '',
					  (c.fwopt || []).join(' ') ].filter(Boolean).join(' · ') || '-'
				]),
				E('td', { 'class': 'td' }, [ c.label || '' ].concat(prob ? prob.map(p => E('div', { 'class': 'fwd-problem' }, [ p ])) : [])),
				E('td', { 'class': 'td fwd-actions' }, [
					btn(c.enabled ? _('Disable') : _('Enable'), '', () => { c.enabled = !c.enabled; this.markDirty(); reopen(); }),
					btn(_('Edit'), 'cbi-button-edit', () => { ui.hideModal(); this.editConnection(c.id, null, reopen); }),
					btn(_('Delete'), 'cbi-button-remove', () => this.deleteConnection(c.id, false, reopen))
				])
			]);
		});

		const scratch = clone(this.model);
		const mergeable = fwm.mergeConnections(scratch, bd.conns.map(c => c.id));

		const doMerge = () => {
			const n = fwm.mergeConnections(this.model, bd.conns.map(c => c.id));
			ui.hideModal();
			this.markDirty();
			ui.addNotification(null, E('p', [ _('Merged %d connection(s). The generated rules behave the same.').format(n) ]), 'info');
			reopen();
		};

		ui.showModal('%s → %s'.format(so.label, dob.label), [
			E('p', [ _('All connections from "%s" to "%s". The number is their position in the evaluation order (first match wins).').format(so.label, dob.label) ]),
			E('div', { 'style': 'max-height:55vh;overflow:auto' }, [
				this.table([ '#', _('Services'), _('Action'), _('Options'), _('Name / problems'), '' ], rows, '')
			]),
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				btn(_('+ Add connection'), 'cbi-button-add fwd-left', () => { ui.hideModal(); this.editConnection(null, { src: src, dest: dest }, reopen); }),
				mergeable ? E('button', {
					'class': 'cbi-button cbi-button-action', 'click': doMerge,
					'title': _('Combine connections that only differ in their services into one')
				}, [ _('Merge %d compatible').format(mergeable + 1 > bd.conns.length ? bd.conns.length : mergeable + 1) ]) : '',
				btn(_('Close'), '', ui.hideModal)
			])
		], 'cbi-modal');
	},

	moveConnection(id, dir) {
		const order = fwm.connectionOrder(this.model);
		const i = order.indexOf(id), j = i + dir;
		if (i < 0 || j < 0 || j >= order.length)
			return;
		[ order[i], order[j] ] = [ order[j], order[i] ];
		this.markDirty();
	},

	/* --- service editor ----------------------------------------------- */

	editService(id) {
		const isNew = !id;
		const s = isNew ? { id: fwm.randomId('s', this.model.services), label: '', proto: 'tcp', port: [], icmp_type: [], member: [] }
		                : clone(this.model.services[id]);

		const wLabel = new ui.Textfield(s.label, { optional: false });
		const PROTOS = { tcp: 'TCP', udp: 'UDP', tcpudp: 'TCP + UDP', icmp: 'ICMP', any: _('Any protocol'), group: _('Group of services'), other: _('Other protocol…') };
		const isOther = !(s.proto in PROTOS);
		const wProto = new ui.Select(isOther ? 'other' : s.proto, PROTOS, { optional: false, sort: false });
		const wOther = new ui.Textfield(isOther ? s.proto : '', { optional: true, placeholder: 'esp, gre, igmp, 47 …' });
		const wPorts = new ui.DynamicList(s.port, {}, { datatype: 'portrange', optional: true, placeholder: '443 or 8000-8010' });
		const icmpChoices = {};
		for (const t of ICMP_TYPES) icmpChoices[t] = t;
		const wIcmp = new ui.DynamicList(s.icmp_type, icmpChoices, { optional: true });
		const wMembers = new ui.Dropdown(s.member, this.serviceChoices(s.id), { multiple: true, optional: true, display_items: 5, dropdown_items: 10 });

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('Name'), wLabel),
			this.formRow(_('Protocol'), wProto),
			this.formRow(_('Protocol name'), wOther, _('Name or number from /etc/protocols.'), 'other'),
			this.formRow(_('Ports'), wPorts, _('Destination ports or ranges. Leave empty for all ports.'), 'ports'),
			this.formRow(_('ICMP types'), wIcmp, _('Leave empty for all ICMP types.'), 'icmp'),
			this.formRow(_('Members'), wMembers, null, 'members')
		]);

		const update = () => {
			const p = wProto.getValue();
			this.showRow(form, 'ports', [ 'tcp', 'udp', 'tcpudp' ].includes(p));
			this.showRow(form, 'icmp', p == 'icmp');
			this.showRow(form, 'members', p == 'group');
			this.showRow(form, 'other', p == 'other');
		};
		form.addEventListener('widget-change', update);

		const save = () => {
			wLabel.triggerValidation();
			s.label = wLabel.getValue().trim();
			s.proto = wProto.getValue();
			if (s.proto == 'other') {
				s.proto = wOther.getValue().trim().toLowerCase();
				if (!/^[a-z0-9_-]+$/.test(s.proto) || [ 'other', 'all' ].includes(s.proto))
					return ui.addNotification(null, E('p', [ _('Please enter a valid protocol name.') ]), 'warning');
			}
			s.port = fwm.toList(wPorts.getValue());
			s.icmp_type = fwm.toList(wIcmp.getValue());
			s.member = fwm.toList(wMembers.getValue());
			if (!s.label || !wPorts.isValid())
				return ui.addNotification(null, E('p', [ _('Please correct the highlighted fields.') ]), 'warning');
			this.model.services[s.id] = s;
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(isNew ? _('New service') : _('Edit service'), [
			form,
			this.dialogButtons(isNew ? null : () => { ui.hideModal(); this.deleteService(s.id); }, save)
		]);
		update();
	},

	deleteService(id) {
		const users = Object.values(this.model.connections).filter(c => c.service.includes(id));
		const groups = Object.values(this.model.services).filter(g => g.proto == 'group' && g.member.includes(id));

		const doDelete = () => {
			for (const c of users)
				c.service = c.service.filter(x => x != id);
			for (const g of groups)
				g.member = g.member.filter(x => x != id);
			delete this.model.services[id];
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(_('Delete service'), [
			E('p', [ _('Delete service "%s"?').format(this.model.services[id].label) ]),
			users.length ? E('p', [ _('It is used by %d connection(s); it will be removed from them. A connection without services allows any protocol.').format(users.length) ]) : '',
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': doDelete }, [ _('Delete') ])
			])
		]);
	},

	/* --- import of existing rules -------------------------------------- */

	describeConnection(model, c) {
		const lbl = id => model.objects[id] ? model.objects[id].label : '?';
		const svcs = c.service.map(id => {
			const s = fwm.allServices(model)[id];
			return s ? s.label : id;
		}).join(', ');
		let s = '%s → %s: %s, %s'.format(lbl(c.src), lbl(c.dest), svcs, ACTION_LABELS[c.action]);
		if (c.nat == 'dnat') s += ', ' + _('port forward') + (c.ext_port ? ' ' + c.ext_port : '');
		if (c.family) s += ', ' + (c.family == 'ipv4' ? 'IPv4' : 'IPv6');
		if (c.fwopt && c.fwopt.length) s += ', ' + c.fwopt.join(' ');
		if (!c.enabled) s += ' (' + _('disabled') + ')';
		return s;
	},

	importOptions() {
		return {
			zones: this.zones,
			zoneForAddress: a => this.zoneForAddress(a),
			labels: { wan: _('Internet'), router: _('This router') }
		};
	},

	importDialog() {
		const fwSections = uci.sections('firewall');
		const scratch = clone(this.model);
		const results = fwm.importFirewall(scratch, fwSections, this.importOptions());

		if (!results.length)
			return ui.addNotification(null, E('p', [ _('There are no hand written rules or port forwards to import.') ]), 'info');

		const boxes = {};
		const rows = results.map(r => {
			const cb = E('input', { 'type': 'checkbox', 'checked': r.ok ? '' : null, 'disabled': r.ok ? null : '' });
			boxes[r.sid] = cb;
			return E('tr', { 'class': 'tr' + (r.ok ? '' : ' disabled') }, [
				E('td', { 'class': 'td' }, [ cb ]),
				E('td', { 'class': 'td' }, [ r.name ]),
				E('td', { 'class': 'td' }, [ { rule: _('Rule'), redirect: _('Port forward'), nat: _('NAT') }[r.type] ]),
				E('td', { 'class': 'td' }, [ r.ok ? this.describeConnection(scratch, scratch.connections[r.conn])
				                                  : E('span', { 'class': 'fwd-problem' }, [ r.reason ]) ])
			]);
		});

		const removeCb = E('input', { 'type': 'checkbox', 'checked': '', 'id': 'fwd-import-remove' });
		const nOk = results.filter(r => r.ok).length;

		const doImport = () => {
			const only = results.filter(r => r.ok && boxes[r.sid].checked).map(r => r.sid);
			if (!only.length)
				return ui.hideModal();

			const res = fwm.importFirewall(this.model, fwSections, Object.assign({ only: only }, this.importOptions()));
			let n = 0;
			for (const r of res) {
				if (!r.ok)
					continue;
				n++;
				if (removeCb.checked)
					uci.remove('firewall', r.sid);
			}

			ui.hideModal();
			this.sel = null;
			this.markDirty();
			this.fitView();
			ui.addNotification(null, E('p', [
				_('Imported %d rule(s). Review them, then press "Save & Apply".').format(n),
				removeCb.checked ? ' ' + _('The original sections are removed when you save.') : ''
			]), 'info');
		};

		ui.showModal(_('Import existing rules'), [
			E('p', [ _('These rules and port forwards from /etc/config/firewall can be turned into objects and connections. Matching objects and services are reused, missing ones are created. Imported connections are appended at the end of the connection list; rules you do not import stay active exactly as they are.') ]),
			E('div', { 'style': 'max-height:50vh;overflow:auto' }, [
				this.table([ '', _('Name'), _('Type'), _('Becomes') ], rows, '')
			]),
			E('p', { 'style': 'margin-top:1em' }, [
				removeCb, ' ',
				E('label', { 'for': 'fwd-import-remove' }, [ _('Remove the original sections after importing (otherwise they stay active in addition to the generated rules)') ])
			]),
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-positive', 'click': doImport, 'disabled': nOk ? null : '' }, [ _('Import selected') ])
			])
		], 'cbi-modal');
	},

	/* --- tables ------------------------------------------------------- */

	table(headers, rows, empty) {
		return E('table', { 'class': 'table fwd-table' }, [
			E('tr', { 'class': 'tr table-titles' }, headers.map(h => E('th', { 'class': 'th' }, [ h ])))
		].concat(rows.length ? rows : [
			E('tr', { 'class': 'tr placeholder' }, [ E('td', { 'class': 'td', 'colspan': headers.length }, [ E('em', [ empty ]) ]) ])
		]));
	},

	smallBtn(title, cls, fn, disabled) {
		return E('button', {
			'class': 'cbi-button ' + (cls || ''), 'title': title, 'disabled': disabled ? '' : null,
			'click': ui.createHandlerFn(this, fn)
		}, [ title ]);
	},

	renderConnections() {
		const order = fwm.connectionOrder(this.model);
		const rows = order.map((cid, i) => {
			const c = this.model.connections[cid];
			const so = this.model.objects[c.src], dob = this.model.objects[c.dest];
			const prob = this.problems[cid];
			return E('tr', { 'class': 'tr' + (c.enabled ? '' : ' disabled') }, [
				E('td', { 'class': 'td' }, [ String(i + 1) ]),
				E('td', { 'class': 'td' }, [ so ? so.label : '?' ]),
				E('td', { 'class': 'td' }, [ dob ? dob.label : '?' ]),
				E('td', { 'class': 'td' }, (c.service.length ? c.service : [ 'b_any' ]).map(s => E('span', { 'class': 'fwd-pill' }, [ fwm.serviceLabel(this.model, s) ]))),
				E('td', { 'class': 'td' }, [ E('span', { 'class': 'fwd-pill ' + c.action }, [ ACTION_LABELS[c.action] ]) ]),
				E('td', { 'class': 'td' }, [ { none: '-', masq: _('Masquerade'), dnat: _('Port forward') + (c.ext_port ? ' (' + c.ext_port + ')' : '') }[c.nat] ]),
				E('td', { 'class': 'td' }, [ c.label || '' ].concat(prob ? prob.map(p => E('div', { 'class': 'fwd-problem' }, [ p ])) : [])),
				E('td', { 'class': 'td fwd-actions' }, [
					this.smallBtn('▲', '', () => this.moveConnection(cid, -1), i == 0),
					this.smallBtn('▼', '', () => this.moveConnection(cid, 1), i == order.length - 1),
					this.smallBtn(c.enabled ? _('Disable') : _('Enable'), '', () => { c.enabled = !c.enabled; this.markDirty(); }),
					this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editConnection(cid)),
					this.smallBtn(_('Delete'), 'cbi-button-remove', () => this.deleteConnection(cid, true))
				])
			]);
		});

		dom.content(this.connPane, [
			E('p', { 'class': 'cbi-section-descr' }, [ _('Connections are turned into firewall rules in this order. The first matching rule wins, so put specific blocks above broad allows. Traffic not covered by any connection follows the zone defaults shown under "Generated rules".') ]),
			this.table([ '#', _('From'), _('To'), _('Services'), _('Action'), _('NAT'), _('Name / problems'), '' ], rows,
				_('No connections yet. Drag from the blue handle of an object to another object on the desktop.')),
			E('div', { 'class': 'fwd-toolbar' }, [
				this.smallBtn(_('Import existing rules…'), '', () => this.importDialog())
			])
		]);
	},

	renderObjects() {
		const used = id => Object.values(this.model.connections).filter(c => c.src == id || c.dest == id).length;
		const rows = Object.values(this.model.objects).sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label)).map(o => E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, [ TYPE_LABELS[o.type] ]),
			E('td', { 'class': 'td' }, [ o.label ]),
			E('td', { 'class': 'td' }, [ (o.type == 'router' || o.type == 'group') ? '-' : (o.zone || '?') ]),
			E('td', { 'class': 'td' }, [ o.type == 'group' ? o.member.map(m => this.model.objects[m] ? this.model.objects[m].label : m).join(', ')
				: o.type == 'ipset' ? _('set %s').format(o.ipset) : o.address.join(', ') ]),
			E('td', { 'class': 'td' }, [ String(used(o.id)) ]),
			E('td', { 'class': 'td fwd-actions' }, [
				this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editObject(o.id)),
				o.type != 'router' ? this.smallBtn(_('Delete'), 'cbi-button-remove', () => this.deleteObject(o.id)) : ''
			])
		]));

		dom.content(this.objPane, [
			this.table([ _('Type'), _('Name'), _('Zone'), _('Addresses / members'), _('Connections'), '' ], rows, _('No objects')),
			E('div', { 'class': 'fwd-toolbar' }, [
				this.smallBtn(_('+ Host'), 'cbi-button-add', () => this.editObject(null, 'host')),
				this.smallBtn(_('+ Network'), 'cbi-button-add', () => this.editObject(null, 'network')),
				this.smallBtn(_('+ Group'), 'cbi-button-add', () => this.editObject(null, 'group')),
				this.smallBtn(_('+ Zone'), 'cbi-button-add', () => this.editObject(null, 'zone')),
				this.smallBtn(_('+ IP set'), 'cbi-button-add', () => this.editObject(null, 'ipset'))
			])
		]);
	},

	renderServices() {
		const custom = Object.values(this.model.services).sort((a, b) => a.label.localeCompare(b.label));
		const rows = custom.map(s => E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, [ s.label ]),
			E('td', { 'class': 'td' }, [ s.proto == 'group' ? s.member.map(m => fwm.serviceLabel(this.model, m)).join(', ') : fwm.describeService(s) ]),
			E('td', { 'class': 'td fwd-actions' }, [
				this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editService(s.id)),
				this.smallBtn(_('Delete'), 'cbi-button-remove', () => this.deleteService(s.id))
			])
		]));

		const builtin = fwm.BUILTIN_SERVICES.map(s => E('span', { 'class': 'fwd-pill', 'title': fwm.describeService(s) }, [ s.label ]));

		dom.content(this.svcPane, [
			E('h4', [ _('Custom services') ]),
			this.table([ _('Name'), _('Definition'), '' ], rows, _('No custom services yet.')),
			E('div', { 'class': 'fwd-toolbar' }, [ this.smallBtn(_('+ Service'), 'cbi-button-add', () => this.editService(null)) ]),
			E('h4', [ _('Built-in services') ]),
			E('div', {}, builtin)
		]);
	},

	uciText(sections) {
		const q = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
		return sections.map(s => {
			const lines = [ 'config %s %s'.format(s['.type'], q(s['.name'])) ];
			for (const k in s) {
				if (k.charAt(0) == '.')
					continue;
				if (Array.isArray(s[k]))
					for (const v of s[k]) lines.push('\tlist %s %s'.format(k, q(v)));
				else
					lines.push('\toption %s %s'.format(k, q(s[k])));
			}
			return lines.join('\n');
		}).join('\n\n');
	},

	renderPreview() {
		const zoneRows = uci.sections('firewall', 'zone').map(z => {
			const fwd = uci.sections('firewall', 'forwarding').filter(f => f.src == z.name).map(f => f.dest);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ z.name ]),
				E('td', { 'class': 'td' }, [ z.input || 'DROP' ]),
				E('td', { 'class': 'td' }, [ z.output || 'DROP' ]),
				E('td', { 'class': 'td' }, [ z.forward || 'DROP' ]),
				E('td', { 'class': 'td' }, [ fwd.length ? fwd.join(', ') : '-' ]),
				E('td', { 'class': 'td' }, [ z.masq == '1' ? _('yes') : _('no') ])
			]);
		});

		dom.content(this.previewPane, [
			this.gen.problems.length ? E('div', { 'class': 'cbi-section' }, [
				E('h4', [ _('Problems') ]),
				E('p', [ _('Connections with problems are skipped when generating rules.') ])
			].concat(this.gen.problems.map(p => {
				const c = this.model.connections[p.conn];
				const so = c && this.model.objects[c.src], dob = c && this.model.objects[c.dest];
				return E('div', { 'class': 'fwd-problem' }, [ '%s → %s: %s'.format(so ? so.label : '?', dob ? dob.label : '?', p.msg) ]);
			}))) : '',
			E('h4', [ _('Zone defaults') ]),
			E('p', [ _('Traffic that no connection matches is handled by these zone policies (edit them under Network → Firewall).') ]),
			this.table([ _('Zone'), _('Input'), _('Output'), _('Forward'), _('Forwards to'), _('Masquerading') ], zoneRows, _('No zones')),
			E('h4', [ _('Generated sections (/etc/config/firewall)') ]),
			E('div', { 'class': 'fwd-preview', 'style': 'max-height:none' }, [ this.gen.sections.length ? this.uciText(this.gen.sections) : _('(nothing generated yet)') ])
		]);
	},

	/* --- save --------------------------------------------------------- */

	applyOps(conf, ops) {
		for (const o of ops) {
			switch (o.op) {
			case 'remove': uci.remove(conf, o.name); break;
			case 'add':    uci.add(conf, o.type, o.name); break;
			case 'set':    uci.set(conf, o.name, o.option, o.value); break;
			case 'unset':  uci.unset(conf, o.name, o.option); break;
			}
		}
	},

	handleSave(ev) {
		const owned = s => [ 'object', 'service', 'connection' ].includes(s['.type']);

		if (!uci.get('fwdesktop', 'global'))
			uci.add('fwdesktop', 'global', 'global');

		this.applyOps('fwdesktop', fwm.diffSections(uci.sections('fwdesktop'), fwm.toSections(this.model), owned));

		const gen = fwm.generate(this.model);
		this.applyOps('firewall', fwm.diffSections(uci.sections('firewall'), gen.sections, fwm.isOwnedFirewallSection));

		/* keep generated sections in connection order, after hand written ones */
		const want = gen.sections.map(s => s['.name']);
		const have = uci.sections('firewall').filter(fwm.isOwnedFirewallSection).map(s => s['.name']);
		if (want.join(' ') != have.join(' '))
			for (const name of want)
				uci.move('firewall', name, null);

		return uci.save().then(() => {
			this.dirty = false;
			this.refresh();
			return ui.changes.init();
		});
	},

	handleReset(ev) {
		window.location.reload();
	}
});
