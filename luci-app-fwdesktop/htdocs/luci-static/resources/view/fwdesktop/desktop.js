'use strict';
'require view';
'require dom';
'require ui';
'require uci';
'require rpc';
'require validation';
'require fs';
'require fwdesktop.model as fwm';

/* bump together with PKG_RELEASE so browsers fetch the matching stylesheet */
const ASSET_REV = '1.0.0-25';

const RT_TABLES = '/etc/iproute2/rt_tables';

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

/* default symbol colours, keep in sync with .fwd-type-* in desktop.css */
const TYPE_COLORS = {
	router: '#5d6b7a', zone: '#7a5bb5', host: '#3a7bd5',
	network: '#2b9aa0', group: '#b5803a', ipset: '#a0457a'
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

function intToIp4(n) {
	return [ n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
}

/* network part of an IPv6 address for a given prefix length, compressed */
function ip6Network(addr, len) {
	const halves = String(addr).split('::');
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
	const words = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail).map(w => parseInt(w || '0', 16) || 0);
	for (let i = 0; i < 8; i++) {
		const bits = Math.max(0, Math.min(16, len - i * 16));
		words[i] &= bits ? (0xffff << (16 - bits)) & 0xffff : 0;
	}
	let hex = words.map(w => w.toString(16)).join(':');
	const runs = hex.match(/(^|:)0(:0)+(:|$)/g);
	if (runs) {
		const longest = runs.reduce((a, b) => b.length > a.length ? b : a);
		hex = hex.replace(longest, '::');
	}
	return hex.replace(/^:([^:])/, '::$1') + '/' + len;
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
			L.resolveDefault(callNetworkDump(), []),
			L.resolveDefault(fs.read(RT_TABLES), '')
		]);
	},

	/* --- setup -------------------------------------------------------- */

	render(data) {
		this.hints = data[1] || {};
		this.ifaces = data[2] || [];
		this.rtTables = this.parseRtTables(data[3] || '');
		this.rtAll = this.parseRtAll(data[3] || '');
		this.rtPending = {};
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
		this.setPane = E('div');
		this.backupPane = E('div');
		this.settingsPane = E('div');
		this.routePane = E('div');
		this.zonePane = E('div');
		this.previewPane = E('div');

		const tabs = E('div', {}, [
			this.desktopPane = E('div', { 'class': 'fwd-desktop', 'data-tab': 'desktop', 'data-tab-title': _('Desktop') }, [
				this.renderToolbar(),
				this.canvasWrap
			]),
			E('div', { 'data-tab': 'connections', 'data-tab-title': _('Connections') }, [ this.connPane ]),
			E('div', { 'data-tab': 'objects', 'data-tab-title': _('Objects') }, [ this.objPane ]),
			E('div', { 'data-tab': 'services', 'data-tab-title': _('Services') }, [ this.svcPane ]),
			E('div', { 'data-tab': 'zones', 'data-tab-title': _('Zones') }, [ this.zonePane ]),
			E('div', { 'data-tab': 'ipsets', 'data-tab-title': _('IP sets') }, [ this.setPane ]),
			E('div', { 'data-tab': 'backup', 'data-tab-title': _('Backup') }, [ this.backupPane ]),
			E('div', { 'data-tab': 'routing', 'data-tab-title': _('Routing') }, [ this.routePane ]),
			E('div', { 'data-tab': 'settings', 'data-tab-title': _('Settings') }, [ this.settingsPane ]),
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

		window.addEventListener('beforeunload', ev => {
			if (this.dirty || this.stageTimer) {
				this.stage();
				ev.preventDefault();
				ev.returnValue = '';
			}
		});

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
		/* seeded objects are written together with the first real change */
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

	/*
	 * Every change is staged into LuCI's pending changes shortly after it is
	 * made (like LuCI forms do on "Save"), so it survives leaving the page.
	 * "Save & Apply" then only has to apply.
	 */
	markDirty() {
		this.dirty = true;
		this.refresh();
		this.scheduleStage();
	},

	scheduleStage() {
		window.clearTimeout(this.stageTimer);
		this.stageTimer = window.setTimeout(() => {
			this.stageTimer = null;
			this.stage().catch(e => ui.addNotification(null, E('p', [ _('Could not stage the changes: %s').format(e && e.message || e) ]), 'danger'));
		}, 300);
	},

	/* serialised: each stage runs after the previous one finished */
	stage() {
		window.clearTimeout(this.stageTimer);
		this.stageTimer = null;
		this.stageChain = (this.stageChain || Promise.resolve()).catch(() => {}).then(() => {
			this.dirty = false;
			return this.writeUci();
		}).then(() => this.ensureRtTables()).then(() => {
			this.staged = true;
			this.renderStatus();
			return ui.changes.init();
		});
		this.renderStatus();
		return this.stageChain;
	},

	refresh() {
		this.zones = uci.sections('firewall', 'zone').map(z => z.name).filter(Boolean);
		this.gen = fwm.generate(this.model);
		this.problems = {};
		for (const p of this.gen.problems)
			(this.problems[p.conn] = this.problems[p.conn] || []).push(p.msg);

		this.drawCanvas();
		this.renderConnections();
		this.renderObjects();
		this.renderServices();
		this.renderSets();
		this.renderZones();
		this.renderBackup();
		this.renderSettings();
		this.renderRouting();
		this.renderPreview();

		this.renderStatus();
	},

	renderStatus() {
		const n = this.gen.problems.length;
		dom.content(this.statusEl, [
			_('%d objects, %d connections, %d firewall sections').format(
				Object.keys(this.model.objects).length,
				Object.keys(this.model.connections).length,
				this.gen.sections.length),
			n ? E('span', { 'class': 'fwd-problem', 'style': 'margin-left:1em' }, [ _('Problems: %d').format(n) ]) : '',
			(this.dirty || this.stageTimer)
				? E('em', { 'style': 'margin-left:1em' }, [ _('Saving changes…') ])
				: this.staged ? E('em', { 'style': 'margin-left:1em' }, [ _('Changes are pending until you press "Save & Apply"') ]) : ''
		]);
	},

	/* buttons that look like the object symbols on the desktop */
	addObjectButtons() {
		return [ 'host', 'network', 'group', 'zone', 'ipset' ].map(type => E('button', {
			'class': 'cbi-button fwd-add fwd-type-' + type,
			'title': _('Add %s').format(TYPE_LABELS[type]),
			'click': ui.createHandlerFn(this, () => this.editObject(null, type))
		}, [
			S('svg', { 'class': 'fwd-add-icon', 'width': 22, 'height': 22, 'viewBox': '-11 -11 22 22', 'aria-hidden': 'true' }, [
				S('rect', { 'class': 'fwd-band', 'x': -11, 'y': -11, 'width': 22, 'height': 22, 'rx': 5 }),
				S('path', { 'class': 'fwd-icon', 'd': ICONS[type], 'transform': 'scale(.85)' })
			]),
			E('span', { 'class': 'fwd-add-plus' }, [ '+' ]),
			E('span', [ TYPE_LABELS[type] ])
		]));
	},

	/* --- toolbar ------------------------------------------------------ */

	renderToolbar() {
		const btn = (title, cls, fn) => E('button', {
			'class': 'cbi-button ' + (cls || ''),
			'click': ui.createHandlerFn(this, fn)
		}, [ title ]);

		return E('div', { 'class': 'fwd-toolbar' }, [
			...this.addObjectButtons(),
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
			this.canvasBox = E('div', { 'class': 'fwd-canvas-wrap' }, [
				this.svg,
				this.tooltip = E('div', { 'class': 'fwd-tooltip' }),
				this.infoCard = E('div', { 'class': 'fwd-infocard' })
			]),
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
		this.positionInfoCard();
	},

	/* --- interface info card for zones and the router ------------------- */

	showInfoCard(id) {
		this.infoId = id;
		this.hideTooltip();
		dom.content(this.infoCard, E('em', [ _('Loading interfaces…') ]));
		this.infoCard.classList.add('visible');
		this.positionInfoCard();

		L.resolveDefault(callNetworkDump(), this.ifaces).then(ifaces => {
			this.ifaces = ifaces || [];
			if (this.infoId != id)
				return;
			dom.content(this.infoCard, this.renderInfoCard(this.model.objects[id]));
			this.positionInfoCard();
		});
	},

	hideInfoCard() {
		this.infoId = null;
		if (this.infoCard)
			this.infoCard.classList.remove('visible');
	},

	positionInfoCard() {
		const o = this.infoId && this.model.objects[this.infoId];
		if (!o || !this.infoCard) {
			this.hideInfoCard();
			return;
		}
		const r = this.canvasBox.getBoundingClientRect();
		const k = this.pan.k;
		const cw = this.infoCard.offsetWidth || 320, ch = this.infoCard.offsetHeight || 120;
		let x = this.pan.x + (o.x + NODE_W / 2) * k + 14;
		let y = this.pan.y + (o.y - NODE_H / 2) * k;
		if (x + cw > r.width - 8)
			x = this.pan.x + (o.x - NODE_W / 2) * k - cw - 14;
		x = Math.max(8, Math.min(x, r.width - cw - 8));
		y = Math.max(8, Math.min(y, r.height - ch - 8));
		this.infoCard.style.left = x + 'px';
		this.infoCard.style.top = y + 'px';
	},

	renderIface(ifc, zone) {
		const name = ifc ? ifc.interface : '?';
		const dev = ifc ? (ifc.l3_device || ifc.device || '') : '';
		const addrs = [];

		if (ifc) {
			for (const a of (ifc['ipv4-address'] || []))
				addrs.push('%s/%d'.format(a.address, a.mask));
			for (const a of (ifc['ipv6-address'] || []))
				addrs.push('%s/%d'.format(a.address, a.mask));
			for (const a of (ifc['ipv6-prefix-assignment'] || []))
				if (a['local-address'])
					addrs.push('%s/%d'.format(a['local-address'].address, a['local-address'].mask));
		}

		return E('tr', { 'class': ifc && !ifc.up ? 'disabled' : '' }, [
			E('td', {}, [
				E('strong', [ name ]),
				E('div', { 'class': 'fwd-tip-sub' }, [ [ dev, ifc ? ifc.proto : _('not configured'), zone ? _('zone %s').format(zone) : '' ].filter(Boolean).join(' · ') ])
			]),
			E('td', {}, [
				E('span', { 'class': 'fwd-pill ' + (ifc && ifc.up ? 'ACCEPT' : 'DROP') }, [ ifc && ifc.up ? _('up') : _('down') ])
			]),
			E('td', { 'class': 'fwd-mono' }, addrs.length ? addrs.map(a => E('div', [ a ])) : [ E('em', [ _('no address') ]) ])
		]);
	},

	renderInfoCard(o) {
		const byName = {};
		for (const ifc of this.ifaces)
			byName[ifc.interface] = ifc;

		const close = E('button', { 'class': 'fwd-card-close', 'title': _('Close'), 'click': () => this.hideInfoCard() }, [ '×' ]);
		const zones = uci.sections('firewall', 'zone');
		const rows = [];
		const extra = [];
		let title;

		if (o.type == 'router') {
			title = _('Interfaces of this router');
			for (const ifc of this.ifaces) {
				if (ifc.interface == 'loopback')
					continue;
				const z = zones.filter(zs => fwm.toList(zs.network).includes(ifc.interface))[0];
				rows.push(this.renderIface(ifc, z ? z.name : _('no zone')));
			}
		}
		else {
			const zs = zones.filter(z => z.name == o.zone)[0];
			title = _('Zone %s').format(o.zone);
			if (!zs)
				return [ close, E('div', { 'class': 'fwd-tip-title' }, [ title ]), E('div', { 'class': 'fwd-problem' }, [ _('This zone does not exist in the firewall configuration.') ]) ];

			for (const net of fwm.toList(zs.network))
				rows.push(this.renderIface(byName[net] || { interface: net, up: false, proto: _('not configured') }, null));

			const devs = fwm.toList(zs.device), subnets = fwm.toList(zs.subnet);
			if (devs.length)
				extra.push(E('div', [ _('Devices: %s').format(devs.join(', ')) ]));
			if (subnets.length)
				extra.push(E('div', [ _('Subnets: %s').format(subnets.join(', ')) ]));
			extra.push(E('div', { 'class': 'fwd-tip-sub' }, [
				_('Policy: input %s · output %s · forward %s').format(zs.input || 'DROP', zs.output || 'DROP', zs.forward || 'DROP') +
				(zs.masq == '1' ? ' · ' + _('masquerading') : '')
			]));
		}

		return [
			close,
			E('div', { 'class': 'fwd-tip-title' }, [ title ]),
			rows.length ? E('table', {}, rows) : E('em', [ _('No interfaces in this zone.') ]),
			...extra,
			E('div', { 'class': 'fwd-card-links' }, [
				E('a', { 'href': L.url('admin/network/network') }, [ _('Interfaces') ]),
				' · ',
				E('a', { 'href': L.url('admin/network/firewall/zones') }, [ _('Zone settings') ])
			])
		];
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
				S('path', { 'class': 'fwd-band', 'd': band, 'style': o.color ? 'fill:' + o.color : null }),
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
			if (this.infoId == d.id)
				this.positionInfoCard();
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
				const o = this.model.objects[d.id];
				if (o && (o.type == 'zone' || o.type == 'router'))
					this.showInfoCard(d.id);
				else
					this.hideInfoCard();
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
			if (!d.moved) {
				this.hideInfoCard();
				if (this.sel) {
					this.sel = null;
					this.updateSelection();
				}
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

	/* subnets of the interfaces covered by a zone, from the live interface state */
	zoneNetworkChoices(zone) {
		const c = {};
		const zs = uci.sections('firewall', 'zone').filter(z => z.name == zone)[0];
		if (!zs)
			return c;
		const nets = fwm.toList(zs.network);
		for (const ifc of this.ifaces) {
			if (!nets.includes(ifc.interface))
				continue;
			const add = (cidr, note) => { if (!c[cidr]) c[cidr] = '%s (%s%s)'.format(cidr, ifc.interface, note ? ', ' + note : ''); };
			for (const a of (ifc['ipv4-address'] || [])) {
				const ip = ip4ToInt(a.address), m = +a.mask;
				if (ip == null || !(m >= 0 && m <= 32)) continue;
				const mask = m ? (~0 << (32 - m)) >>> 0 : 0;
				add(intToIp4((ip & mask) >>> 0) + '/' + m);
			}
			for (const a of (ifc['ipv6-prefix-assignment'] || []))
				if (a.address && a.mask) add(ip6Network(a.address, +a.mask), _('IPv6 prefix'));
			for (const a of (ifc['ipv6-address'] || []))
				if (a.address && a.mask && !/^fe80:/i.test(a.address)) add(ip6Network(a.address, +a.mask));
		}
		for (const sn of fwm.toList(zs.subnet))
			if (!c[sn]) c[sn] = '%s (%s)'.format(sn, _('zone subnet'));
		return c;
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

	editObject(id, type, draft) {
		const isNew = !id;
		const o = draft ? clone(draft) : isNew ? {
			id: fwm.randomId('o', this.model.objects), type: type, label: '', zone: null,
			address: [], member: [], comment: '', x: 0, y: 0
		} : clone(this.model.objects[id]);

		const wLabel = new ui.Textfield(o.label, { optional: o.type == 'ipset', placeholder: o.type == 'ipset' ? _('same as the set name') : TYPE_LABELS[o.type] });
		const wZone = new ui.Select(o.zone || (o.type == 'zone' ? null : this.zones[0]), this.zoneChoices(), { optional: false });
		let zoneTouched = !isNew;
		const makeAddr = (values, zone) => new ui.DynamicList(values, (o.type == 'host') ? this.hostChoices() : this.zoneNetworkChoices(zone), {
			datatype: o.type == 'host' ? 'ipaddr(1)' : 'or(cidr,iprange,ipaddr(1))',
			optional: false
		});
		let wAddr = makeAddr(o.address, o.zone || this.zones[0]);
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
		const newSetBtn = E('button', { 'class': 'cbi-button cbi-button-add', 'style': 'margin-left:.5em', 'click': ui.createHandlerFn(this, () => {
			const draft = Object.assign({}, o, { label: wLabel.getValue(), zone: wZone.getValue(), comment: wComment.getValue() });
			ui.hideModal();
			this.editSet(null, name => {
				this.editObject(isNew ? null : o.id, o.type, Object.assign(draft, { ipset: name || draft.ipset }));
			});
		}) }, [ _('+ New IP set') ]);

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
			rows.push(this.formRow(_('IP set'), E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap' }, [ wSet.render(), newSetBtn ]), Object.keys(setChoices).length
				? _('An fw4 IP set (Network → Firewall → IP Sets). Its entries can change without touching the rules, e.g. block lists or sets filled by dnsmasq.')
				: _('No IP sets are defined yet. Create one with "+ New IP set".')));

		/* symbol colour: native RGB picker plus hex field, '' means type default */
		let color = o.color || '';
		const def = TYPE_COLORS[o.type];
		const picker = E('input', { 'type': 'color', 'value': color || def, 'style': 'width:3em;height:2em;padding:0;border:0;background:none;cursor:pointer' });
		const hex = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': color, 'placeholder': def, 'maxlength': 7, 'style': 'width:7em' });
		const sample = S('svg', { 'width': 22, 'height': 22, 'viewBox': '-11 -11 22 22' }, [
			S('rect', { 'x': -11, 'y': -11, 'width': 22, 'height': 22, 'rx': 5, 'style': 'fill:' + (color || def) }),
			S('path', { 'd': ICONS[o.type], 'transform': 'scale(.85)', 'style': 'fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round' })
		]);
		const setColor = (c) => {
			color = c;
			picker.value = c || def;
			if (document.activeElement !== hex) hex.value = c;
			sample.firstChild.style.fill = c || def;
		};
		picker.addEventListener('input', () => setColor(picker.value.toLowerCase()));
		hex.addEventListener('input', () => {
			const v = hex.value.trim();
			if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v.toLowerCase());
			else if (v === '') setColor('');
		});
		const swatches = Object.values(TYPE_COLORS).concat([ '#2e9d5b', '#c93c3c', '#d9822b', '#455a64' ])
			.filter((c, i, l) => l.indexOf(c) == i)
			.map(c => E('span', { 'class': 'fwd-swatch', 'title': c, 'style': 'background:' + c, 'click': () => setColor(c == def ? '' : c) }));
		rows.push(this.formRow(_('Colour'), E('div', { 'class': 'fwd-color-row' }, [
			sample, picker, hex,
			E('button', { 'class': 'cbi-button', 'click': () => setColor('') }, [ _('Default') ]),
			E('span', { 'class': 'fwd-swatches' }, swatches)
		]), _('Colour of the symbol on the desktop. Stored in /etc/config/fwdesktop, not in the firewall configuration.')));

		rows.push(this.formRow(_('Comment'), wComment));

		const form = E('div', { 'class': 'fwd-form' }, rows);

		form.addEventListener('widget-change', ev => {
			if (wZone.node && wZone.node.contains(ev.target)) {
				zoneTouched = true;
				/* offer the subnets of the newly selected zone */
				if (o.type == 'network' && wAddr.node && wAddr.node.parentNode) {
					const next = makeAddr(fwm.toList(wAddr.getValue()), wZone.getValue());
					const old = wAddr.node;
					old.parentNode.replaceChild(next.render(), old);
					wAddr = next;
				}
				return;
			}
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
			o.color = (color && color != def) ? color : '';
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

		ui.showModal((isNew ? _('New %s') : _('Edit %s')).format(o.type == 'ipset' ? _('IP set object') : TYPE_LABELS[o.type].toLowerCase()), [
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
				...this.addObjectButtons()
			])
		]);
	},

	/* --- fw4 zone management -------------------------------------------- */

	zoneSection(name) {
		return uci.sections('firewall', 'zone').filter(z => z.name == name)[0];
	},

	/* hand written rules / redirects / nat sections that name the zone */
	zoneRuleUsers(name) {
		return uci.sections('firewall').filter(sec =>
			[ 'rule', 'redirect', 'nat' ].includes(sec['.type']) && !fwm.isOwnedFirewallSection(sec) &&
			(sec.src == name || sec.dest == name));
	},

	zoneObjectUsers(name) {
		return Object.values(this.model.objects).filter(o => o.type != 'router' && o.type != 'group' && o.zone == name);
	},

	networkChoices() {
		const c = {};
		for (const ifc of uci.sections('network', 'interface'))
			if (ifc['.name'] != 'loopback')
				c[ifc['.name']] = ifc['.name'] + (ifc.proto ? ' (' + ifc.proto + ')' : '');
		return c;
	},

	editZone(sid) {
		const isNew = !sid;
		const cur = isNew ? { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } : (uci.get('firewall', sid) || {});
		const oldName = cur.name || '';
		const POL = { ACCEPT: _('accept'), REJECT: _('reject'), DROP: _('drop') };
		const otherZones = {};
		for (const z of this.zones) if (z != oldName) otherZones[z] = z;
		const fwds = uci.sections('firewall', 'forwarding').filter(f => f.enabled != '0');
		const fwdTo = fwds.filter(f => f.src == oldName && oldName).map(f => f.dest);
		const fwdFrom = fwds.filter(f => f.dest == oldName && oldName).map(f => f.src);

		const wName = new ui.Textfield(oldName, { optional: false, datatype: 'ucifw4zonename', placeholder: 'guest' });
		const wIn = new ui.Select(cur.input || 'DROP', POL, { optional: false, sort: false });
		const wOut = new ui.Select(cur.output || 'DROP', POL, { optional: false, sort: false });
		const wFwd = new ui.Select(cur.forward || 'DROP', POL, { optional: false, sort: false });
		const wMasq = new ui.Checkbox(cur.masq == '1' ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wMss = new ui.Checkbox(cur.mtu_fix == '1' ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wNets = new ui.Dropdown(fwm.toList(cur.network), this.networkChoices(), { multiple: true, optional: true, display_items: 5, placeholder: _('-- none --') });
		const wTo = new ui.Dropdown(fwdTo, otherZones, { multiple: true, optional: true, display_items: 5, placeholder: _('-- none --') });
		const wFrom = new ui.Dropdown(fwdFrom, otherZones, { multiple: true, optional: true, display_items: 5, placeholder: _('-- none --') });
		const wObj = new ui.Checkbox('1', { value_enabled: '1', value_disabled: '0' });
		const errors = E('div');

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('Name'), wName),
			this.formRow(_('Input'), wIn, _('Traffic from this zone to the router itself.')),
			this.formRow(_('Output'), wOut, _('Traffic from the router into this zone.')),
			this.formRow(_('Forward'), wFwd, _('Traffic between networks of this zone, and from it to zones without an explicit forwarding.')),
			this.formRow(_('Masquerading'), wMasq, _('Hide traffic leaving through this zone behind the router address (typical for WAN zones).')),
			this.formRow(_('MSS clamping'), wMss),
			this.formRow(_('Covered networks'), wNets, _('A network can belong to one zone only; it is removed from its previous zone.')),
			this.formRow(_('Allow forward to'), wTo, _('Zone forwardings: all traffic from this zone to these zones is allowed (shown as dotted lines on the desktop).')),
			this.formRow(_('Allow forward from'), wFrom),
			isNew ? this.formRow(_('Add to desktop'), wObj, _('Create a zone object for the new zone.')) : '',
			errors
		]);

		const save = () => {
			wName.triggerValidation();
			const name = wName.getValue().trim();
			const msgs = [];
			if (!name || !wName.isValid()) msgs.push(_('Please enter a valid zone name.'));
			else if (name != oldName && this.zoneSection(name)) msgs.push(_('A zone named "%s" already exists.').format(name));
			if (msgs.length)
				return dom.content(errors, msgs.map(m => E('div', { 'class': 'fwd-problem' }, [ m ])));

			const id = isNew ? uci.add('firewall', 'zone') : sid;
			const nets = fwm.toList(wNets.getValue());
			uci.set('firewall', id, 'name', name);
			uci.set('firewall', id, 'input', wIn.getValue());
			uci.set('firewall', id, 'output', wOut.getValue());
			uci.set('firewall', id, 'forward', wFwd.getValue());
			uci.set('firewall', id, 'masq', wMasq.getValue() == '1' ? '1' : null);
			uci.set('firewall', id, 'mtu_fix', wMss.getValue() == '1' ? '1' : null);
			uci.set('firewall', id, 'network', nets.length ? nets : null);

			/* a network belongs to one zone only */
			for (const z of uci.sections('firewall', 'zone')) {
				if (z['.name'] == id) continue;
				const left = fwm.toList(z.network).filter(n => !nets.includes(n));
				if (left.length != fwm.toList(z.network).length)
					uci.set('firewall', z['.name'], 'network', left.length ? left : null);
			}

			/* rename: follow through to forwardings, hand written rules and desktop objects */
			if (!isNew && oldName && name != oldName) {
				for (const sec of uci.sections('firewall')) {
					if (![ 'forwarding', 'rule', 'redirect', 'nat' ].includes(sec['.type']) || fwm.isOwnedFirewallSection(sec)) continue;
					if (sec.src == oldName) uci.set('firewall', sec['.name'], 'src', name);
					if (sec.dest == oldName) uci.set('firewall', sec['.name'], 'dest', name);
				}
				for (const o of this.zoneObjectUsers(oldName)) {
					o.zone = name;
					if (o.type == 'zone' && o.label == oldName.toUpperCase()) o.label = name.toUpperCase();
				}
			}

			/* forwardings of this zone: replace with the selected ones */
			for (const f of uci.sections('firewall', 'forwarding'))
				if (f.src == name || f.dest == name || (oldName && (f.src == oldName || f.dest == oldName)))
					uci.remove('firewall', f['.name']);
			const addFwd = (src, dest) => {
				const fid = uci.add('firewall', 'forwarding');
				uci.set('firewall', fid, 'src', src);
				uci.set('firewall', fid, 'dest', dest);
			};
			for (const z of fwm.toList(wTo.getValue())) addFwd(name, z);
			for (const z of fwm.toList(wFrom.getValue())) addFwd(z, name);

			if (isNew && wObj.getValue() == '1') {
				const oid = fwm.randomId('o', this.model.objects);
				const r = this.svg.getBoundingClientRect();
				this.model.objects[oid] = {
					id: oid, type: 'zone', zone: name, label: name.toUpperCase(), address: [], member: [], comment: '', color: '',
					x: snap(((r.width || 600) / 2 - this.pan.x) / this.pan.k), y: snap(((r.height || 400) / 2 - this.pan.y) / this.pan.k)
				};
			}

			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(isNew ? _('New zone') : _('Edit zone %s').format(oldName), [
			form,
			this.dialogButtons(isNew ? null : () => { ui.hideModal(); this.deleteZone(sid); }, save)
		], 'cbi-modal');
	},

	deleteZone(sid) {
		const z = uci.get('firewall', sid);
		if (!z) return;
		const rules = this.zoneRuleUsers(z.name);

		if (rules.length)
			return ui.showModal(_('Zone in use'), [
				E('p', [ _('The zone "%s" is used by these firewall rules that were not created on the desktop:').format(z.name) ]),
				E('ul', rules.map(r => E('li', [ r.name || r['.name'] ]))),
				E('p', [ _('Change or delete those rules first (Network → Firewall), or import them into the desktop.') ]),
				E('div', { 'class': 'fwd-dialog-buttons' }, [ E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Close') ]) ])
			]);

		const objs = this.zoneObjectUsers(z.name);
		const conns = Object.values(this.model.connections).filter(c => objs.some(o => c.src == o.id || c.dest == o.id));
		const fwds = uci.sections('firewall', 'forwarding').filter(f => f.src == z.name || f.dest == z.name);

		const doDelete = () => {
			for (const c of conns)
				delete this.model.connections[c.id];
			for (const o of objs) {
				for (const g of Object.values(this.model.objects))
					if (g.type == 'group') g.member = g.member.filter(m => m != o.id);
				delete this.model.objects[o.id];
			}
			for (const f of fwds)
				uci.remove('firewall', f['.name']);
			uci.remove('firewall', sid);
			ui.hideModal();
			this.sel = null;
			this.hideInfoCard();
			this.markDirty();
		};

		ui.showModal(_('Delete zone'), [
			E('p', [ _('Delete the zone "%s"?').format(z.name) ]),
			fwm.toList(z.network).length ? E('p', [ _('Its networks (%s) will no longer belong to any zone, so traffic on them is no longer filtered by zone rules.').format(fwm.toList(z.network).join(', ')) ]) : '',
			fwds.length ? E('p', [ _('%d zone forwarding(s) are removed.').format(fwds.length) ]) : '',
			objs.length ? E('p', [ _('This also deletes %d desktop object(s) and %d connection(s) in this zone.').format(objs.length, conns.length) ]) : '',
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': doDelete }, [ _('Delete') ])
			])
		]);
	},

	renderZones() {
		const fwds = uci.sections('firewall', 'forwarding').filter(f => f.enabled != '0');
		const pill = v => E('span', { 'class': 'fwd-pill ' + ({ ACCEPT: 'ACCEPT', REJECT: 'REJECT', DROP: 'DROP' }[String(v || 'DROP').toUpperCase()] || '') }, [ String(v || 'DROP').toLowerCase() ]);
		const rows = uci.sections('firewall', 'zone').map(z => {
			const objs = this.zoneObjectUsers(z.name), rules = this.zoneRuleUsers(z.name);
			const to = fwds.filter(f => f.src == z.name).map(f => f.dest), from = fwds.filter(f => f.dest == z.name).map(f => f.src);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ E('strong', [ z.name || '?' ]), z.masq == '1' ? E('div', { 'class': 'fwd-tip-sub' }, [ _('masquerading') ]) : '' ]),
				E('td', { 'class': 'td' }, [ fwm.toList(z.network).join(', ') || E('em', [ _('none') ]) ]),
				E('td', { 'class': 'td' }, [ pill(z.input), ' ', pill(z.output), ' ', pill(z.forward) ]),
				E('td', { 'class': 'td' }, [
					to.length ? E('div', [ '→ ' + to.join(', ') ]) : '',
					from.length ? E('div', [ '← ' + from.join(', ') ]) : '',
					(!to.length && !from.length) ? '-' : ''
				]),
				E('td', { 'class': 'td' }, [
					[ objs.length ? _('%d desktop object(s)').format(objs.length) : '', rules.length ? _('%d other rule(s)').format(rules.length) : '' ].filter(Boolean).join(', ') || '-'
				]),
				E('td', { 'class': 'td fwd-actions' }, [
					this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editZone(z['.name'])),
					this.smallBtn(_('Delete'), 'cbi-button-remove', () => this.deleteZone(z['.name']))
				])
			]);
		});

		dom.content(this.zonePane, [
			E('p', { 'class': 'cbi-section-descr' }, [ _('Firewall zones group networks (interfaces). Policies apply to traffic no connection matches. Changes are written to /etc/config/firewall when you press Save & Apply.') ]),
			this.table([ _('Zone'), _('Networks'), _('Input / Output / Forward'), _('Forwardings'), _('Used by'), '' ], rows, _('No zones.')),
			E('div', { 'class': 'fwd-toolbar' }, [ this.smallBtn(_('+ New zone'), 'cbi-button-add', () => this.editZone(null)) ])
		]);
	},

	/* --- fw4 IP set management ---------------------------------------- */

	setSection(name) {
		return uci.sections('firewall', 'ipset').filter(st => st.name == name)[0];
	},

	/* manual (non generated) rules / redirects that reference a set */
	setRuleUsers(name) {
		return uci.sections('firewall').filter(sec =>
			(sec['.type'] == 'rule' || sec['.type'] == 'redirect') && !fwm.isOwnedFirewallSection(sec) &&
			sec.ipset && fwm.toList(sec.ipset).join(' ').replace(/^!/, '').split(/[\s,]+/)[0] == name);
	},

	setObjectUsers(name) {
		return Object.values(this.model.objects).filter(o => o.type == 'ipset' && o.ipset == name);
	},

	entryDatatype(family, match) {
		const m = fwm.toList(match);
		if (m.length != 1)
			return null;
		const t = m[0].replace(/^(src|dest|dst)_/, '');
		const v6 = (family == 'ipv6' || family == '6');
		switch (t) {
		case 'ip':   return v6 ? 'ip6addr(1)' : 'ip4addr(1)';
		case 'net':  return v6 ? 'or(cidr6,ip6addr(1))' : 'or(cidr4,ip4addr(1),iprange4)';
		case 'mac':  return 'macaddr';
		case 'port': return 'portrange';
		}
		return null;
	},

	editSet(sid, onDone) {
		const isNew = !sid;
		const cur = isNew ? {} : (uci.get('firewall', sid) || {});
		const oldName = cur.name || '';

		const MATCHES = {
			'net': _('Network or address (net)'), 'ip': _('Address (ip)'),
			'src_net': 'src_net', 'dest_net': 'dest_net', 'src_ip': 'src_ip', 'dest_ip': 'dest_ip',
			'mac': _('MAC address (mac)'), 'src_mac': 'src_mac', 'dest_port': _('Destination port (dest_port)'), 'port': 'port'
		};

		const wName = new ui.Textfield(oldName, { optional: false, datatype: 'and(uciname,maxlength(31))', placeholder: 'blocklist' });
		const wFamily = new ui.Select(cur.family == 'ipv6' || cur.family == '6' ? 'ipv6' : 'ipv4', { ipv4: 'IPv4', ipv6: 'IPv6' }, { optional: false, sort: false });
		const wMatch = new ui.Dropdown(fwm.toList(cur.match).length ? fwm.toList(cur.match) : [ 'net' ], MATCHES, { multiple: true, optional: false, sort: false, display_items: 3 });
		const wEntries = new ui.Textarea(fwm.toList(cur.entry).join('\n'), { rows: 8, placeholder: '192.0.2.0/24\n198.51.100.7' });
		const wFile = new ui.Textfield(cur.loadfile || '', { optional: true, datatype: 'file', placeholder: '/etc/blocklist.txt' });
		const wTimeout = new ui.Textfield(cur.timeout && cur.timeout != '-1' ? cur.timeout : '', { optional: true, datatype: 'uinteger', placeholder: _('never') });
		const wCounters = new ui.Checkbox(cur.counters == '1' ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wComment = new ui.Textfield(cur.comment || '', { optional: true });
		const errors = E('div');

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('Name'), wName, _('Letters, digits and underscore. Rules refer to the set by this name.')),
			this.formRow(_('Family'), wFamily),
			this.formRow(_('Match'), wMatch, _('What the entries are. "net" accepts networks and single addresses; the direction (source/destination) is chosen where the set is used.')),
			this.formRow(_('Entries'), wEntries, _('One entry per line. Lines starting with # are ignored.')),
			this.formRow(_('Load from file'), wFile, _('Optional: a file on the router with one entry per line, loaded when the firewall starts (e.g. a downloaded block list).')),
			this.formRow(_('Entry timeout'), wTimeout, _('Seconds after which dynamically added entries expire. Empty: never.')),
			this.formRow(_('Counters'), wCounters, _('Count packets and bytes per entry.')),
			this.formRow(_('Comment'), wComment),
			errors
		]);

		const save = () => {
			wName.triggerValidation(); wFile.triggerValidation(); wTimeout.triggerValidation();
			const name = wName.getValue().trim();
			const family = wFamily.getValue();
			const match = fwm.toList(wMatch.getValue());
			const lines = wEntries.getValue().split(/\n/).map(l => l.trim()).filter(l => l && l.charAt(0) != '#');
			const msgs = [];

			if (!name || !wName.isValid()) msgs.push(_('Please enter a valid name (letters, digits, underscore).'));
			else if (name != oldName && this.setSection(name)) msgs.push(_('An IP set named "%s" already exists.').format(name));
			if (!match.length) msgs.push(_('Please choose what the set matches.'));
			if (!wFile.isValid() || !wTimeout.isValid()) msgs.push(_('Please correct the highlighted fields.'));

			const dt = this.entryDatatype(family, match);
			if (dt) {
				const v = validation.create(E('input'), dt);
				const bad = lines.filter(l => {
					v.value = l;
					v.error = null;
					return v.vstack[0].apply(v, v.vstack[1]) !== true;
				});
				if (bad.length)
					msgs.push(_('Invalid entries for this match type: %s').format(bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' …' : '')));
			}

			if (msgs.length) {
				dom.content(errors, msgs.map(m => E('div', { 'class': 'fwd-problem' }, [ m ])));
				return;
			}

			const id = isNew ? uci.add('firewall', 'ipset') : sid;
			uci.set('firewall', id, 'name', name);
			uci.set('firewall', id, 'family', family);
			uci.set('firewall', id, 'match', match);
			uci.set('firewall', id, 'entry', lines.length ? lines : null);
			uci.set('firewall', id, 'loadfile', wFile.getValue().trim() || null);
			uci.set('firewall', id, 'timeout', wTimeout.getValue().trim() || null);
			uci.set('firewall', id, 'counters', wCounters.getValue() == '1' ? '1' : null);
			uci.set('firewall', id, 'comment', wComment.getValue().trim() || null);

			/* keep references consistent when a set is renamed */
			if (!isNew && oldName && name != oldName) {
				for (const o of this.setObjectUsers(oldName)) {
					o.ipset = name;
					if (o.label == oldName) o.label = name;
				}
				for (const sec of this.setRuleUsers(oldName)) {
					const v = fwm.toList(sec.ipset).join(' ');
					uci.set('firewall', sec['.name'], 'ipset', v.replace(/^(!?)[^\s,]+/, '$1' + name));
				}
			}

			ui.hideModal();
			this.markDirty();
			if (onDone) onDone(name);
		};

		ui.showModal(isNew ? _('New IP set') : _('Edit IP set %s').format(oldName), [
			form,
			this.dialogButtons(isNew ? null : () => { ui.hideModal(); this.deleteSet(sid); }, save,
				onDone ? () => { ui.hideModal(); onDone(null); } : null)
		], 'cbi-modal');
	},

	deleteSet(sid) {
		const st = uci.get('firewall', sid);
		if (!st) return;
		const objs = this.setObjectUsers(st.name);
		const rules = this.setRuleUsers(st.name);

		if (rules.length)
			return ui.showModal(_('IP set in use'), [
				E('p', [ _('The set "%s" is used by these firewall rules that were not created on the desktop:').format(st.name) ]),
				E('ul', rules.map(r => E('li', [ r.name || r['.name'] ]))),
				E('p', [ _('Change or delete those rules first (Network → Firewall), or import them into the desktop.') ]),
				E('div', { 'class': 'fwd-dialog-buttons' }, [ E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Close') ]) ])
			]);

		const conns = Object.values(this.model.connections).filter(c => objs.some(o => c.src == o.id || c.dest == o.id));

		const doDelete = () => {
			for (const c of conns)
				delete this.model.connections[c.id];
			for (const o of objs) {
				for (const g of Object.values(this.model.objects))
					if (g.type == 'group') g.member = g.member.filter(m => m != o.id);
				delete this.model.objects[o.id];
			}
			uci.remove('firewall', sid);
			ui.hideModal();
			this.sel = null;
			this.hideInfoCard();
			this.markDirty();
		};

		ui.showModal(_('Delete IP set'), [
			E('p', [ _('Delete the IP set "%s"?').format(st.name) ]),
			objs.length ? E('p', [ _('This also deletes %d desktop object(s) and %d connection(s) that use it.').format(objs.length, conns.length) ]) : '',
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': doDelete }, [ _('Delete') ])
			])
		]);
	},

	/* --- policy routing: network rule/rule6 and route/route6 sections ---- */

	/* all name -> number entries of rt_tables, reserved ones included */
	parseRtAll(text) {
		const t = {};
		for (const line of String(text).split('\n')) {
			const m = line.trim().match(/^(\d+)\s+(\S+)/);
			if (m) t[m[2]] = m[1];
		}
		return t;
	},

	/* the user's own named tables (no reserved numbers) */
	parseRtTables(text) {
		const all = this.parseRtAll(text), t = {};
		for (const name in all)
			if (!/^(0|128|253|254|255)$/.test(all[name]))
				t[name] = all[name];
		return t;
	},

	/* table value that netifd can resolve without an rt_tables entry */
	isBuiltinTable(t) {
		return !t || /^\d+$/.test(t) || [ 'main', 'local', 'default' ].includes(t);
	},

	/* names used by routing rules/routes that rt_tables does not know (yet) */
	unresolvedTables() {
		const out = [];
		for (const s of uci.sections('network')) {
			const t = (s['.type'] == 'rule' || s['.type'] == 'rule6') ? s.lookup
				: (s['.type'] == 'route' || s['.type'] == 'route6') ? s.table : null;
			if (t && !this.isBuiltinTable(t) && !this.rtAll[t] && !out.includes(t))
				out.push(t);
		}
		return out;
	},

	/* numbers that are taken: rt_tables entries, numeric tables in use, pending names */
	takenTableNumbers(except) {
		const taken = {};
		for (const name in this.rtAll) taken[this.rtAll[name]] = true;
		for (const s of uci.sections('network'))
			for (const t of [ s.lookup, s.table ])
				if (t && /^\d+$/.test(t)) taken[+t] = true;
		for (const name in this.rtPending)
			if (name != except) taken[this.rtPending[name]] = true;
		return taken;
	},

	/* free table number for a new name; own tables usually start at 100 */
	freeTableNumber(taken) {
		for (let n = 100; n <= 252; n++) if (!taken[n]) return n;
		for (let n = 1; n < 100; n++) if (!taken[n]) return n;
		return null;
	},

	/* number a new name gets on save: the one chosen in the editor, else the next free one */
	pendingTableNumbers() {
		const res = {};
		const taken = this.takenTableNumbers();
		for (const name of this.unresolvedTables()) {
			let n = this.rtPending[name];
			if (!n) {
				n = this.freeTableNumber(taken);
				if (!n) continue;
				taken[n] = true;
			}
			res[name] = n;
		}
		return res;
	},

	/*
	 * Appends names to /etc/iproute2/rt_tables. The file is read again first,
	 * so edits made elsewhere are kept; a name that exists meanwhile is left
	 * alone, a number that is taken meanwhile is replaced by a free one.
	 */
	addRtTables(wanted) {
		if (!Object.keys(wanted).length)
			return Promise.resolve();
		return L.resolveDefault(fs.read(RT_TABLES), '').then(text => {
			const all = this.parseRtAll(text);
			const taken = {};
			for (const name in all) taken[all[name]] = true;
			const lines = [];
			for (const name in wanted) {
				if (all[name]) continue;
				let n = +wanted[name];
				if (!(n >= 1 && n <= 252) || taken[n]) n = this.freeTableNumber(taken);
				if (!n) continue;
				taken[n] = true;
				all[name] = String(n);
				lines.push(n + '\t' + name);
			}
			if (!lines.length)
				return;
			const head = text && !/\n$/.test(text) ? text + '\n' : (text || '');
			return fs.write(RT_TABLES, head + '# added by Firewall Desktop\n' + lines.join('\n') + '\n').then(() => {
				this.rtAll = all;
				this.rtTables = this.parseRtTables(head + lines.join('\n'));
			});
		});
	},

	/* runs with every stage, so the names exist before any apply (also one from another page) */
	ensureRtTables() {
		const wanted = this.pendingTableNumbers();
		if (!Object.keys(wanted).length)
			return Promise.resolve();
		return this.addRtTables(wanted).then(() => {
			this.rtPending = {};
			this.renderRouting();
		}).catch(e => {
			ui.addNotification(null, E('p', [ _('Could not add the routing table names %s to %s: %s').format(Object.keys(wanted).join(', '), RT_TABLES, e && e.message || e) ]), 'danger');
		});
	},

	tableChoices(withMain) {
		const c = {};
		if (withMain) c[''] = _('main (default)');
		c.main = 'main (254)';
		c.local = 'local (255)';
		for (const name in this.rtTables)
			c[name] = '%s (%s)'.format(name, this.rtTables[name]);
		const pending = this.pendingTableNumbers();
		for (const name in pending)
			c[name] = _('%s (new, %s)').format(name, pending[name]);
		const used = uci.sections('network').map(s => s.lookup || s.table).filter(Boolean);
		for (const t of used)
			if (!c[t]) c[t] = t;
		return c;
	},

	/*
	 * "Table number" row for the rule and route editors: shown when the
	 * chosen table is a name rt_tables does not know yet.
	 */
	newTableField(wTable) {
		const wNum = new ui.Textfield('', { optional: true, datatype: 'range(1,252)' });
		const descr = E('div', { 'class': 'cbi-value-description' });
		const row = E('div', { 'class': 'fwd-row', 'data-name': 'tnum' }, [
			E('label', {}, [ _('Table number') ]),
			E('div', { 'class': 'fwd-field' }, [ wNum.render(), descr ])
		]);
		const name = () => fwm.toList(wTable.getValue())[0] || '';
		const isNew = () => {
			const t = name();
			return /^[A-Za-z0-9_.-]+$/.test(t) && !this.isBuiltinTable(t) && !this.rtAll[t];
		};
		let shown = null;
		const update = () => {
			const t = name();
			row.classList.toggle('hidden', !isNew());
			if (!isNew() || shown == t) return;
			shown = t;
			const n = this.rtPending[t] || this.pendingTableNumbers()[t] || this.freeTableNumber(this.takenTableNumbers(t));
			wNum.setValue(n ? String(n) : '');
			dom.content(descr, _('"%s" is not in %s yet. It is added there with this number when you save this dialog, so netifd can resolve the name.').format(t, RT_TABLES));
		};
		return {
			row: row,
			update: update,
			/* returns an error message or null */
			validate: () => {
				if (!isNew()) return null;
				wNum.triggerValidation();
				const n = +(wNum.getValue() || '').trim();
				if (!wNum.isValid() || !n) return _('Please enter a table number from 1 to 252.');
				/* numeric tables in use are no conflict: the name may label such a table */
				const owner = Object.keys(this.rtAll).find(k => this.rtAll[k] == String(n))
					|| Object.keys(this.rtPending).find(k => k != name() && this.rtPending[k] == n);
				if (owner)
					return _('Table number %d is already used by "%s".').format(n, owner);
				return null;
			},
			commit: () => { if (isNew()) this.rtPending[name()] = +(wNum.getValue() || '').trim(); }
		};
	},

	ifaceChoices(optional) {
		const c = {};
		if (optional) c[''] = _('any');
		for (const ifc of uci.sections('network', 'interface'))
			if (ifc['.name'] != 'loopback')
				c[ifc['.name']] = ifc['.name'];
		return c;
	},

	ruleSummary(r) {
		const parts = [];
		if (r.in) parts.push(_('in %s').format(r.in));
		if (r.out) parts.push(_('out %s').format(r.out));
		if (r.src) parts.push(_('from %s').format(r.src));
		if (r.dest) parts.push(_('to %s').format(r.dest));
		if (r.ipproto) parts.push(r.ipproto + (r.dport ? ' ' + _('port %s').format(r.dport) : '') + (r.sport ? ' ' + _('sport %s').format(r.sport) : ''));
		if (r.mark) parts.push(_('mark %s').format(r.mark));
		if (r.tos) parts.push(_('tos %s').format(r.tos));
		if (r.uidrange) parts.push(_('uid %s').format(r.uidrange));
		return (r.invert == '1' ? _('not') + ' ' : '') + (parts.join(', ') || _('all traffic'));
	},

	ruleAction(r) {
		if (r.action) return r.action;
		if (r.goto) return _('goto %s').format(r.goto);
		if (r.lookup) return _('lookup %s').format(r.lookup);
		return '-';
	},

	editRule(sid, family) {
		const isNew = !sid;
		const cur = isNew ? {} : (uci.get('network', sid) || {});
		let fam = isNew ? (family || 'ipv4') : (cur['.type'] == 'rule6' ? 'ipv6' : 'ipv4');
		const ACTIONS_R = { lookup: _('Use routing table'), goto: _('Go to rule'), prohibit: 'prohibit', unreachable: 'unreachable', blackhole: 'blackhole', throw: 'throw' };
		const mode = cur.action || (cur.goto ? 'goto' : 'lookup');

		const wFam = new ui.Select(fam, { ipv4: 'IPv4', ipv6: 'IPv6' }, { optional: false, sort: false, disabled: !isNew });
		const wPrio = new ui.Textfield(cur.priority || '', { optional: true, datatype: 'range(1,32765)', placeholder: _('automatic') });
		const wIn = new ui.Select(cur.in || '', this.ifaceChoices(true), { optional: true, sort: true });
		const wOut = new ui.Select(cur.out || '', this.ifaceChoices(true), { optional: true, sort: true });
		const addrDt = () => fam == 'ipv6' ? 'or(cidr6,ip6addr(1))' : 'or(cidr4,ip4addr(1))';
		const wSrc = new ui.Textfield(cur.src || '', { optional: true, placeholder: fam == 'ipv6' ? '2001:db8::/48' : '192.168.10.0/24' });
		const wDest = new ui.Textfield(cur.dest || '', { optional: true, placeholder: fam == 'ipv6' ? '2001:db8:1::/48' : '0.0.0.0/0' });
		const wProto = new ui.Select(cur.ipproto || '', { '': _('any'), tcp: 'TCP', udp: 'UDP', icmp: 'ICMP' }, { optional: true, sort: false });
		const wDport = new ui.Textfield(cur.dport || '', { optional: true, datatype: 'portrange', placeholder: '443' });
		const wSport = new ui.Textfield(cur.sport || '', { optional: true, datatype: 'portrange' });
		const wMark = new ui.Textfield(cur.mark || '', { optional: true, placeholder: '0x10/0xff' });
		const wTos = new ui.Textfield(cur.tos || '', { optional: true, datatype: 'range(0,255)' });
		const wUid = new ui.Textfield(cur.uidrange || '', { optional: true, placeholder: '1000-1999' });
		const wInvert = new ui.Checkbox(cur.invert == '1' ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wMode = new ui.Select(mode, ACTIONS_R, { optional: false, sort: false });
		const wTable = new ui.Dropdown(cur.lookup || '', this.tableChoices(false), { optional: true, create: true, sort: false, placeholder: _('table name or number') });
		const tnum = this.newTableField(wTable);
		const wGoto = new ui.Textfield(cur.goto || '', { optional: true, datatype: 'range(1,32765)' });
		const wSup = new ui.Textfield(cur.suppress_prefixlength || '', { optional: true, datatype: 'range(0,128)', placeholder: _('e.g. 0 = ignore default routes') });
		const wEnabled = new ui.Checkbox(cur.disabled == '1' ? '0' : '1', { value_enabled: '1', value_disabled: '0' });
		const wComment = new ui.Textfield(cur.comment || '', { optional: true, placeholder: _('e.g. guest network via DSL') });
		const errors = E('div');

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('Enabled'), wEnabled),
			this.formRow(_('Comment'), wComment),
			this.formRow(_('Family'), wFam),
			this.formRow(_('Priority'), wPrio, _('Rules are evaluated from low to high priority. Empty: netifd picks one.')),
			E('h5', [ _('Match') ]),
			this.formRow(_('Incoming interface'), wIn),
			this.formRow(_('Outgoing interface'), wOut),
			this.formRow(_('Source'), wSrc, _('Source address or network, e.g. the LAN that should use another uplink.')),
			this.formRow(_('Destination'), wDest),
			this.formRow(_('Protocol'), wProto),
			this.formRow(_('Destination port'), wDport, null, 'dport'),
			this.formRow(_('Source port'), wSport, null, 'sport'),
			this.formRow(_('Firewall mark'), wMark, _('mark or mark/mask, e.g. set by a firewall rule.')),
			this.formRow(_('TOS'), wTos),
			this.formRow(_('UID range'), wUid),
			this.formRow(_('Invert match'), wInvert),
			E('h5', [ _('Action') ]),
			this.formRow(_('Action'), wMode),
			this.formRow(_('Routing table'), wTable, _('Name from /etc/iproute2/rt_tables or a number (1-252 for own tables). A new name is added to rt_tables.'), 'table'),
			tnum.row,
			this.formRow(_('Go to priority'), wGoto, null, 'goto'),
			this.formRow(_('Suppress prefix length'), wSup, _('Ignore routes in the table with this prefix length or shorter.'), 'sup'),
			errors
		]);

		const update = () => {
			fam = wFam.getValue();
			const m = wMode.getValue(), pr = wProto.getValue();
			this.showRow(form, 'table', m == 'lookup');
			this.showRow(form, 'sup', m == 'lookup');
			tnum.update();
			if (m != 'lookup') this.showRow(form, 'tnum', false);
			this.showRow(form, 'goto', m == 'goto');
			this.showRow(form, 'dport', pr == 'tcp' || pr == 'udp');
			this.showRow(form, 'sport', pr == 'tcp' || pr == 'udp');
		};
		form.addEventListener('widget-change', update);

		const save = () => {
			const v = w => (w.getValue() || '').toString().trim();
			const msgs = [];
			const vali = (val, dt) => {
				if (!val) return true;
				const vv = validation.create(E('input'), dt);
				vv.value = val;
				return vv.vstack[0].apply(vv, vv.vstack[1]) === true;
			};
			for (const w of [ wPrio, wDport, wSport, wTos, wGoto, wSup ]) w.triggerValidation && w.triggerValidation();
			if ([ wPrio, wDport, wSport, wTos, wGoto, wSup ].some(w => w.isValid && !w.isValid())) msgs.push(_('Please correct the highlighted fields.'));
			if (!vali(v(wSrc), addrDt())) msgs.push(_('Invalid source address.'));
			if (!vali(v(wDest), addrDt())) msgs.push(_('Invalid destination address.'));
			if (v(wMark) && !/^(0x[0-9a-fA-F]+|\d+)(\/(0x[0-9a-fA-F]+|\d+))?$/.test(v(wMark))) msgs.push(_('Invalid firewall mark.'));
			if (v(wUid) && !/^\d+(-\d+)?$/.test(v(wUid))) msgs.push(_('Invalid UID range.'));
			const m = wMode.getValue();
			const table = fwm.toList(wTable.getValue())[0] || '';
			if (m == 'lookup' && !/^[A-Za-z0-9_.-]+$/.test(table)) msgs.push(_('Please choose a routing table.'));
			const tnumErr = m == 'lookup' ? tnum.validate() : null;
			if (tnumErr) msgs.push(tnumErr);
			if (m == 'goto' && !v(wGoto)) msgs.push(_('Please enter the priority to go to.'));
			if (msgs.length)
				return dom.content(errors, msgs.map(x => E('div', { 'class': 'fwd-problem' }, [ x ])));

			const id = isNew ? uci.add('network', fam == 'ipv6' ? 'rule6' : 'rule') : sid;
			const set = (k, val) => uci.set('network', id, k, val ? val : null);
			set('priority', v(wPrio)); set('in', v(wIn)); set('out', v(wOut));
			set('src', v(wSrc)); set('dest', v(wDest)); set('ipproto', v(wProto));
			const tcpudp = [ 'tcp', 'udp' ].includes(v(wProto));
			set('dport', tcpudp ? v(wDport) : ''); set('sport', tcpudp ? v(wSport) : '');
			set('mark', v(wMark)); set('tos', v(wTos)); set('uidrange', v(wUid));
			set('invert', wInvert.getValue() == '1' ? '1' : '');
			set('lookup', m == 'lookup' ? table : '');
			if (m == 'lookup') tnum.commit();
			set('suppress_prefixlength', m == 'lookup' ? v(wSup) : '');
			set('goto', m == 'goto' ? v(wGoto) : '');
			set('action', (m != 'lookup' && m != 'goto') ? m : '');
			set('disabled', wEnabled.getValue() == '1' ? '' : '1');
			set('comment', v(wComment));
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(isNew ? _('New routing rule') : _('Edit routing rule'), [
			form,
			this.dialogButtons(isNew ? null : () => { uci.remove('network', sid); ui.hideModal(); this.markDirty(); }, save)
		], 'cbi-modal');
		update();
	},

	editRoute(sid, family) {
		const isNew = !sid;
		const cur = isNew ? {} : (uci.get('network', sid) || {});
		let fam = isNew ? (family || 'ipv4') : (cur['.type'] == 'route6' ? 'ipv6' : 'ipv4');
		let target = cur.target || '';
		if (target && cur.netmask && target.indexOf('/') < 0) {
			const bits = cur.netmask.split('.').reduce((n, o) => n + ((+o).toString(2).match(/1/g) || []).length, 0);
			target += '/' + bits;
		}

		const wFam = new ui.Select(fam, { ipv4: 'IPv4', ipv6: 'IPv6' }, { optional: false, sort: false, disabled: !isNew });
		const wIface = new ui.Select(cur.interface || null, this.ifaceChoices(false), { optional: false, sort: true });
		const wTarget = new ui.Textfield(target, { optional: false, placeholder: fam == 'ipv6' ? '::/0' : '0.0.0.0/0' });
		const wGw = new ui.Textfield(cur.gateway || '', { optional: true, placeholder: fam == 'ipv6' ? 'fe80::1' : '192.168.178.1' });
		const wTable = new ui.Dropdown(cur.table || '', this.tableChoices(true), { optional: true, create: true, sort: false });
		const tnum = this.newTableField(wTable);
		const wMetric = new ui.Textfield(cur.metric || '', { optional: true, datatype: 'uinteger' });
		const wMtu = new ui.Textfield(cur.mtu || '', { optional: true, datatype: 'range(64,9000)' });
		const wSource = new ui.Textfield(cur.source || '', { optional: true, placeholder: _('preferred source address') });
		const wType = new ui.Select(cur.type || '', { '': 'unicast', local: 'local', broadcast: 'broadcast', multicast: 'multicast', unreachable: 'unreachable', prohibit: 'prohibit', blackhole: 'blackhole', anycast: 'anycast' }, { optional: true, sort: false });
		const wOnlink = new ui.Checkbox(cur.onlink == '1' ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
		const wEnabled = new ui.Checkbox(cur.disabled == '1' ? '0' : '1', { value_enabled: '1', value_disabled: '0' });
		const wComment = new ui.Textfield(cur.comment || '', { optional: true, placeholder: _('e.g. default route for table dsl') });
		const errors = E('div');

		const form = E('div', { 'class': 'fwd-form' }, [
			this.formRow(_('Enabled'), wEnabled),
			this.formRow(_('Comment'), wComment),
			this.formRow(_('Family'), wFam),
			this.formRow(_('Interface'), wIface),
			this.formRow(_('Target'), wTarget, _('Network in CIDR notation; 0.0.0.0/0 (IPv4) or ::/0 (IPv6) is a default route.')),
			this.formRow(_('Gateway'), wGw),
			this.formRow(_('Routing table'), wTable, _('Leave on "main" for normal routes; choose your own table for source routing. A new name is added to rt_tables.')),
			tnum.row,
			this.formRow(_('Metric'), wMetric),
			this.formRow(_('MTU'), wMtu),
			this.formRow(_('Source address'), wSource),
			this.formRow(_('Route type'), wType),
			this.formRow(_('On-link'), wOnlink, _('Gateway is reachable on the link even if outside the interface subnet.')),
			errors
		]);
		form.addEventListener('widget-change', () => { fam = wFam.getValue(); tnum.update(); });

		const save = () => {
			const v = w => (w.getValue() || '').toString().trim();
			const vali = (val, dt) => {
				if (!val) return true;
				const vv = validation.create(E('input'), dt);
				vv.value = val;
				return vv.vstack[0].apply(vv, vv.vstack[1]) === true;
			};
			const v6 = fam == 'ipv6';
			const msgs = [];
			if (!v(wIface)) msgs.push(_('Please choose an interface.'));
			if (!vali(v(wTarget), v6 ? 'or(cidr6,ip6addr(1))' : 'or(cidr4,ip4addr(1))') || !v(wTarget)) msgs.push(_('Invalid target network.'));
			if (!vali(v(wGw), v6 ? 'ip6addr(1)' : 'ip4addr(1)')) msgs.push(_('Invalid gateway.'));
			if (!vali(v(wSource), v6 ? 'ip6addr(1)' : 'ip4addr(1)')) msgs.push(_('Invalid source address.'));
			for (const w of [ wMetric, wMtu ]) w.triggerValidation();
			if (!wMetric.isValid() || !wMtu.isValid()) msgs.push(_('Please correct the highlighted fields.'));
			const table = fwm.toList(wTable.getValue())[0] || '';
			if (table && !/^[A-Za-z0-9_.-]+$/.test(table)) msgs.push(_('Invalid routing table.'));
			const tnumErr = tnum.validate();
			if (tnumErr) msgs.push(tnumErr);
			if (msgs.length)
				return dom.content(errors, msgs.map(x => E('div', { 'class': 'fwd-problem' }, [ x ])));

			const id = isNew ? uci.add('network', v6 ? 'route6' : 'route') : sid;
			const set = (k, val) => uci.set('network', id, k, val ? val : null);
			set('interface', v(wIface)); set('target', v(wTarget)); set('netmask', '');
			set('gateway', v(wGw)); set('table', table == 'main' ? '' : table);
			tnum.commit();
			set('metric', v(wMetric)); set('mtu', v(wMtu)); set('source', v(wSource));
			set('type', v(wType)); set('onlink', wOnlink.getValue() == '1' ? '1' : '');
			set('disabled', wEnabled.getValue() == '1' ? '' : '1');
			set('comment', v(wComment));
			ui.hideModal();
			this.markDirty();
		};

		ui.showModal(isNew ? _('New route') : _('Edit route'), [
			form,
			this.dialogButtons(isNew ? null : () => { uci.remove('network', sid); ui.hideModal(); this.markDirty(); }, save)
		], 'cbi-modal');
		tnum.update();
	},

	showLiveRouting(box) {
		dom.content(box, E('em', { 'class': 'spinning' }, [ _('Loading…') ]));
		const cmds = [ [ '-4', 'rule', 'show' ], [ '-6', 'rule', 'show' ], [ '-4', 'route', 'show', 'table', 'all' ], [ '-6', 'route', 'show', 'table', 'all' ] ];
		return Promise.all(cmds.map(a => L.resolveDefault(fs.exec_direct('/sbin/ip', a), _('(not available)')))).then(res => {
			dom.content(box, cmds.map((a, i) => E('div', [
				E('h5', [ 'ip ' + a.join(' ') ]),
				E('div', { 'class': 'fwd-preview', 'style': 'max-height:22em' }, [ res[i] || _('(empty)') ])
			])));
		});
	},

	renderRouting() {
		const rules = uci.sections('network').filter(s => s['.type'] == 'rule' || s['.type'] == 'rule6')
			.sort((a, b) => (+a.priority || 99999) - (+b.priority || 99999));
		const routes = uci.sections('network').filter(s => s['.type'] == 'route' || s['.type'] == 'route6');
		const fam = s => s['.type'].slice(-1) == '6' ? 'IPv6' : 'IPv4';
		const toggle = sec => E('input', {
			'type': 'checkbox', 'title': _('Enabled'), 'checked': sec.disabled == '1' ? null : '',
			'change': ev => { uci.set('network', sec['.name'], 'disabled', ev.target.checked ? null : '1'); this.markDirty(); }
		});
		const note = sec => sec.comment ? E('div', { 'class': 'fwd-tip-sub' }, [ sec.comment ]) : '';

		const ruleRows = rules.map(r => E('tr', { 'class': 'tr' + (r.disabled == '1' ? ' disabled' : '') }, [
			E('td', { 'class': 'td' }, [ toggle(r) ]),
			E('td', { 'class': 'td' }, [ r.priority || E('em', [ _('auto') ]) ]),
			E('td', { 'class': 'td' }, [ fam(r) ]),
			E('td', { 'class': 'td' }, [ this.ruleSummary(r), note(r) ]),
			E('td', { 'class': 'td' }, [ E('strong', [ this.ruleAction(r) ]) ]),
			E('td', { 'class': 'td fwd-actions' }, [
				this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editRule(r['.name'])),
				this.smallBtn(_('Delete'), 'cbi-button-remove', () => { uci.remove('network', r['.name']); this.markDirty(); })
			])
		]));

		const routeRows = routes.map(r => E('tr', { 'class': 'tr' + (r.disabled == '1' ? ' disabled' : '') }, [
			E('td', { 'class': 'td' }, [ toggle(r) ]),
			E('td', { 'class': 'td' }, [ r.table || 'main' ]),
			E('td', { 'class': 'td' }, [ fam(r) ]),
			E('td', { 'class': 'td' }, [ E('span', { 'class': 'fwd-mono' }, [ (r.target || '-') + (r.netmask ? ' / ' + r.netmask : '') ]), note(r) ]),
			E('td', { 'class': 'td' }, [ [ r.gateway ? _('via %s').format(r.gateway) : '', _('dev %s').format(r.interface || '?'), r.metric ? _('metric %s').format(r.metric) : '', r.type || '' ].filter(Boolean).join(', ') ]),
			E('td', { 'class': 'td fwd-actions' }, [
				this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editRoute(r['.name'])),
				this.smallBtn(_('Delete'), 'cbi-button-remove', () => { uci.remove('network', r['.name']); this.markDirty(); })
			])
		]));

		const live = E('div');
		const pending = this.pendingTableNumbers();
		const unres = this.unresolvedTables().filter(t => !pending[t]);
		dom.content(this.routePane, [
			Object.keys(pending).length ? E('div', { 'class': 'alert-message notice' }, [
				_('New routing table names, not yet in %s (added on the next save): %s').format(RT_TABLES, Object.keys(pending).map(t => '%s = %s'.format(t, pending[t])).join(', '))
			]) : '',
			unres.length ? E('div', { 'class': 'alert-message warning' }, [
				_('No free table number left for: %s. netifd ignores rules and routes with these tables.').format(unres.join(', '))
			]) : '',
			E('p', { 'class': 'cbi-section-descr' }, [ _('Policy routing (source routing): rules decide which routing table a packet uses, e.g. "traffic from 192.168.179.0/24 uses table dsl", and the table holds the routes, e.g. a default route via the DSL uplink. Stored in /etc/config/network and applied with Save & Apply (with rollback protection).') ]),
			E('h4', [ _('Routing rules') ]),
			this.table([ _('On'), _('Priority'), _('Family'), _('Match / comment'), _('Action'), '' ], ruleRows, _('No routing rules.')),
			E('div', { 'class': 'fwd-toolbar' }, [
				this.smallBtn(_('+ IPv4 rule'), 'cbi-button-add', () => this.editRule(null, 'ipv4')),
				this.smallBtn(_('+ IPv6 rule'), 'cbi-button-add', () => this.editRule(null, 'ipv6'))
			]),
			E('h4', [ _('Static routes') ]),
			this.table([ _('On'), _('Table'), _('Family'), _('Target / comment'), _('Via'), '' ], routeRows, _('No static routes.')),
			E('div', { 'class': 'fwd-toolbar' }, [
				this.smallBtn(_('+ IPv4 route'), 'cbi-button-add', () => this.editRoute(null, 'ipv4')),
				this.smallBtn(_('+ IPv6 route'), 'cbi-button-add', () => this.editRoute(null, 'ipv6'))
			]),
			E('h4', [ _('Active state') ]),
			E('div', { 'class': 'fwd-toolbar' }, [ this.smallBtn(_('Show active rules and routes'), '', () => this.showLiveRouting(live)) ]),
			live,
			Object.keys(this.rtTables).length || Object.keys(pending).length ? '' : E('p', { 'class': 'cbi-section-descr' }, [ _('No named routing tables in /etc/iproute2/rt_tables yet. Use a table number (1-252), or type a new name in the rule or route editor and it is added there.') ])
		]);
	},

	/* --- settings (stored in /etc/config/fwdesktop, section global) ----- */

	setting(name) {
		return uci.get('fwdesktop', 'global', name) || '';
	},

	setSetting(name, value) {
		if (!uci.get('fwdesktop', 'global'))
			uci.add('fwdesktop', 'global', 'global');
		uci.set('fwdesktop', 'global', name, value || null);
		this.markDirty();
	},

	renderSettings() {
		const ct = this.setting('ct_reset');
		const radio = (value, title, descr) => E('label', { 'class': 'fwd-radio' }, [
			E('input', { 'type': 'radio', 'name': 'fwd-ct', 'value': value, 'checked': ct == value ? '' : null,
				'change': () => this.setSetting('ct_reset', value) }),
			E('span', [ E('strong', [ title ]), E('div', { 'class': 'cbi-value-description' }, [ descr ]) ])
		]);

		dom.content(this.settingsPane, [
			E('div', { 'class': 'cbi-section' }, [
				E('h4', [ _('Reset affected connections on apply') ]),
				E('p', [ _('The firewall lets packets of established connections pass before any rule is checked, so a new block does not stop a connection that is already open. With this option, the matching connection tracking entries are deleted right after "Save & Apply" was confirmed; those connections are then checked against the new rules again.') ]),
				radio('', _('Off'), _('Existing connections keep running until they end by themselves.')),
				radio('targeted', _('Only affected connections (recommended)'),
					_('Deletes entries matching the rules, port forwards and NAT rules that were added, changed or removed (by protocol, addresses and port). Changes without any address or port (e.g. "any" between whole zones) are skipped.')),
				radio('all', _('All connections'),
					_('Flushes the whole table when firewall rules changed. Every connection, including NATed internet traffic, has to reconnect.')),
				E('p', { 'class': 'cbi-section-descr' }, [ _('Flows accelerated by flow offloading are removed together with their tracking entries. The result is logged on the router (logread -e fwdesktop).') ])
			])
		]);
	},

	/* minimal UCI file parser (for the applied /etc/config/firewall) */
	parseUci(text) {
		const out = [];
		let cur = null;
		const unq = v => {
			v = v.trim();
			if ((v.charAt(0) == "'" && v.slice(-1) == "'") || (v.charAt(0) == '"' && v.slice(-1) == '"'))
				v = v.slice(1, -1);
			return v.replace(/'\\''/g, "'");
		};
		for (const raw of String(text).split('\n')) {
			const line = raw.trim();
			let m;
			if ((m = line.match(/^config\s+(\S+)(?:\s+(.+))?$/))) {
				cur = { '.type': unq(m[1]), '.name': m[2] ? unq(m[2]) : null };
				out.push(cur);
			}
			else if (cur && (m = line.match(/^option\s+(\S+)\s+(.+)$/))) {
				cur[unq(m[1])] = unq(m[2]);
			}
			else if (cur && (m = line.match(/^list\s+(\S+)\s+(.+)$/))) {
				const k = unq(m[1]);
				(cur[k] = Array.isArray(cur[k]) ? cur[k] : []).push(unq(m[2]));
			}
		}
		return out;
	},

	/* conntrack filters for one generated section; null = cannot be targeted */
	ctFiltersFor(sec) {
		const list = v => fwm.toList(v).length ? fwm.toList(v) : [ '' ];
		const port = v => (/^\d+$/).test(v) ? v : '';
		const fam = sec.family == 'ipv4' ? '4' : sec.family == 'ipv6' ? '6' : '';
		let protos = list(sec.proto || (sec['.type'] == 'nat' ? 'all' : 'tcp udp')).join(' ').split(/\s+/);
		if (protos.includes('all') || protos.includes('any')) protos = [ '' ];
		protos = protos.map(p => p == 'icmpv6' ? 'icmpv6' : p);

		const srcs = list(sec.src_ip), dsts = sec['.type'] == 'redirect' ? [ '' ] : list(sec.dest_ip);
		const ports = sec['.type'] == 'redirect' ? list(sec.src_dport) : sec['.type'] == 'nat' ? [ '' ] : list(sec.dest_port);
		const out = [];
		let broad = false;

		for (const p of protos)
			for (const sip of srcs)
				for (const dip of dsts)
					for (const dp of ports) {
						const pp = (p == 'tcp' || p == 'udp') ? port(dp) : '';
						if (!sip && !dip && !pp) { broad = true; continue; }
						out.push([ 'p=' + p, 's=' + sip, 'd=' + dip, 'dp=' + pp, 'f=' + fam ].join(';'));
					}

		return { filters: out, broad: broad };
	},

	/* compare the applied firewall config with what will be applied now */
	ctResetPlan() {
		return L.resolveDefault(fs.read('/etc/config/firewall'), null).then(text => {
			if (text == null)
				return null;
			const oldSecs = {}, newSecs = {};
			for (const sec of this.parseUci(text))
				if (sec['.name'] && fwm.isOwnedFirewallSection(sec)) oldSecs[sec['.name']] = sec;
			for (const sec of fwm.generate(this.model).sections)
				newSecs[sec['.name']] = sec;

			const norm = sec => {
				const o = {};
				for (const k of Object.keys(sec).sort())
					if (k != '.name' && k != 'name') o[k] = Array.isArray(sec[k]) ? sec[k].join(' ') : String(sec[k]);
				return JSON.stringify(o);
			};

			const changed = [];
			for (const n in oldSecs) if (!newSecs[n] || norm(oldSecs[n]) != norm(newSecs[n])) changed.push(oldSecs[n]);
			for (const n in newSecs) if (!oldSecs[n] || norm(oldSecs[n]) != norm(newSecs[n])) changed.push(newSecs[n]);

			let filters = [], broad = 0;
			for (const sec of changed) {
				const r = this.ctFiltersFor(sec);
				filters = filters.concat(r.filters);
				if (r.broad) broad++;
			}
			filters = filters.filter((f, i, l) => l.indexOf(f) == i).slice(0, 300);
			return { changed: changed.length, filters: filters, broad: broad };
		});
	},

	handleSaveApply(ev, mode) {
		const ct = this.setting('ct_reset');
		const planned = ct ? this.ctResetPlan() : Promise.resolve(null);

		return planned.then(plan => this.handleSave(ev).then(() => {
			if (plan && plan.changed) {
				const args = (ct == 'all') ? [ 'flush' ] : plan.filters;
				if (args.length) {
					/* runs once LuCI confirmed the apply, before the page reloads */
					const run = () => {
						document.removeEventListener('uci-applied', run);
						fs.exec('/usr/libexec/fwdesktop-ctreset', args).catch(() => {});
					};
					document.addEventListener('uci-applied', run);
				}
			}
			ui.changes.apply(mode == '0');
		}));
	},

	/* --- backup / restore of /etc/config/firewall + /etc/config/fwdesktop --- */

	backupConfigs() {
		return [ 'firewall', 'fwdesktop', 'network' ];
	},

	/* of /etc/config/network only the routing part is backed up / restored */
	ROUTING_TYPES: [ 'rule', 'rule6', 'route', 'route6' ],

	partSections(conf) {
		const all = uci.sections(conf);
		return conf == 'network' ? all.filter(sec => this.ROUTING_TYPES.includes(sec['.type'])) : all;
	},

	exportConfig(conf) {
		return this.partSections(conf).map(sec => {
			const out = { '.type': sec['.type'] };
			if (sec['.anonymous'])
				out['.anonymous'] = true;
			else
				out['.name'] = sec['.name'];
			for (const k in sec)
				if (k.charAt(0) != '.')
					out[k] = Array.isArray(sec[k]) ? sec[k].slice() : String(sec[k]);
			return out;
		});
	},

	/* rt_tables entries (name -> number) of the tables the routing part uses */
	usedRtTables() {
		const res = {};
		for (const s of this.partSections('network'))
			for (const t of [ s.lookup, s.table ])
				if (t && !this.isBuiltinTable(t) && this.rtAll[t])
					res[t] = this.rtAll[t];
		return res;
	},

	downloadBackup() {
		const data = {
			format: 'luci-app-fwdesktop-backup',
			version: 1,
			created: new Date().toISOString(),
			app: ASSET_REV,
			configs: {}
		};
		for (const conf of this.backupConfigs())
			data.configs[conf] = this.exportConfig(conf);
		data.rt_tables = this.usedRtTables();

		const blob = new Blob([ JSON.stringify(data, null, '\t') + '\n' ], { type: 'application/json' });
		const stamp = data.created.replace(/[:T]/g, '-').replace(/\..*$/, '');
		const a = E('a', { 'href': URL.createObjectURL(blob), 'download': 'firewall-backup-' + stamp + '.json', 'style': 'display:none' });
		document.body.appendChild(a);
		a.click();
		window.setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
	},

	/* returns an error string or null */
	validateBackup(data) {
		if (!data || data.format != 'luci-app-fwdesktop-backup' || data.version != 1 || typeof data.configs != 'object')
			return _('This is not a Firewall Desktop backup file.');

		const nameRe = new RegExp('^[A-Za-z0-9_]+$');
		for (const conf of this.backupConfigs()) {
			const list = data.configs[conf];
			if (list == null)
				continue;
			if (!Array.isArray(list))
				return _('Invalid data for %s.').format(conf);
			for (const sec of list) {
				if (!sec || typeof sec['.type'] != 'string' || !nameRe.test(sec['.type']))
					return _('Invalid section type in %s.').format(conf);
				if (conf == 'network' && !this.ROUTING_TYPES.includes(sec['.type']))
					return _('The network part of a backup may only contain routing rules and routes.');
				if (!sec['.anonymous'] && !(typeof sec['.name'] == 'string' && nameRe.test(sec['.name'])))
					return _('Invalid section name in %s.').format(conf);
				for (const k in sec) {
					if (k.charAt(0) == '.')
						continue;
					const v = sec[k];
					if (!nameRe.test(k) || !(typeof v == 'string' || (Array.isArray(v) && v.every(x => typeof x == 'string'))))
						return _('Invalid option "%s" in %s.').format(k, conf);
				}
			}
		}

		const rt = data.rt_tables;
		if (rt != null && (typeof rt != 'object' || Array.isArray(rt) ||
		    Object.keys(rt).some(k => !/^[A-Za-z0-9_.-]+$/.test(k) || /^\d+$/.test(k) || !/^\d+$/.test(String(rt[k])) || +rt[k] < 1 || +rt[k] > 252)))
			return _('Invalid routing table names in the backup.');

		const fw = data.configs.firewall;
		if (fw != null && (!fw.some(sec => sec['.type'] == 'defaults') || !fw.some(sec => sec['.type'] == 'zone')))
			return _('The firewall configuration in the backup has no defaults or no zones; restoring it would leave the router unprotected.');
		if (!this.backupConfigs().some(conf => Array.isArray(data.configs[conf])))
			return _('The backup contains nothing to restore.');

		return null;
	},

	backupSummary(lists) {
		const count = (conf, type) => (lists[conf] || []).filter(sec => sec['.type'] == type).length;
		return [
			[ _('Zones'), count('firewall', 'zone') ],
			[ _('Forwardings'), count('firewall', 'forwarding') ],
			[ _('Rules'), count('firewall', 'rule') ],
			[ _('Port forwards'), count('firewall', 'redirect') ],
			[ _('NAT rules'), count('firewall', 'nat') ],
			[ _('IP sets'), count('firewall', 'ipset') ],
			[ _('Includes'), count('firewall', 'include') ],
			[ _('Desktop objects'), count('fwdesktop', 'object') ],
			[ _('Connections'), count('fwdesktop', 'connection') ],
			[ _('Custom services'), count('fwdesktop', 'service') ],
			[ _('Routing rules'), count('network', 'rule') + count('network', 'rule6') ],
			[ _('Static routes'), count('network', 'route') + count('network', 'route6') ]
		];
	},

	restoreDialog(data, fileName) {
		const err = this.validateBackup(data);
		if (err)
			return ui.showModal(_('Restore backup'), [
				E('p', { 'class': 'fwd-problem' }, [ err ]),
				E('div', { 'class': 'fwd-dialog-buttons' }, [ E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Close') ]) ])
			]);

		const cur = {};
		for (const conf of this.backupConfigs())
			cur[conf] = this.exportConfig(conf);
		const a = this.backupSummary(cur), b = this.backupSummary(data.configs);
		const PARTS = {
			firewall: [ _('Firewall'), _('/etc/config/firewall: zones, forwardings, rules, port forwards, NAT, IP sets') ],
			fwdesktop: [ _('Desktop'), _('/etc/config/fwdesktop: objects, connections, services, layout, colours, settings') ],
			network: [ _('Routing'), _('routing rules and static routes from /etc/config/network (interfaces are not touched), plus their table names in /etc/iproute2/rt_tables') ]
		};
		const boxes = {};
		const parts = this.backupConfigs().map(conf => {
			const have = Array.isArray(data.configs[conf]);
			const cb = boxes[conf] = E('input', { 'type': 'checkbox', 'checked': have ? '' : null, 'disabled': have ? null : '' });
			return E('label', { 'class': 'fwd-radio' + (have ? '' : ' disabled'), 'style': have ? null : 'opacity:.5' }, [
				cb, E('span', [ E('strong', [ PARTS[conf][0] ]), E('div', { 'class': 'cbi-value-description' }, [ have ? PARTS[conf][1] : _('not in this backup') ]) ])
			]);
		});
		const msg = E('div');
		const go = () => {
			const confs = this.backupConfigs().filter(conf => boxes[conf].checked);
			if (!confs.length)
				return dom.content(msg, E('p', { 'class': 'fwd-problem' }, [ _('Please choose at least one part to restore.') ]));
			return this.restoreBackup(data, confs);
		};

		ui.showModal(_('Restore backup'), [
			E('p', [ _('File: %s, created %s.').format(fileName, data.created ? new Date(data.created).toLocaleString() : '?') ]),
			E('h5', [ _('What should be restored?') ]),
			E('div', parts),
			E('p', { 'class': 'cbi-section-descr' }, [ _('Each chosen part is replaced completely. Firewall and desktop belong together: if you restore only one of them, the desktop rewrites its generated rules with the next change.') ]),
			E('table', { 'class': 'table fwd-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, [ '' ]), E('th', { 'class': 'th' }, [ _('Now') ]), E('th', { 'class': 'th' }, [ _('Backup') ]) ])
			].concat(a.map((row, i) => E('tr', { 'class': 'tr' + (row[1] != b[i][1] ? ' fwd-changed' : '') }, [
				E('td', { 'class': 'td' }, [ row[0] ]), E('td', { 'class': 'td' }, [ String(row[1]) ]), E('td', { 'class': 'td' }, [ String(b[i][1]) ])
			])))),
			E('p', [ _('The restore is applied with LuCI\'s rollback protection: if the router is no longer reachable afterwards, the previous configuration comes back automatically after a short time.') ]),
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, go) }, [ _('Restore and apply') ])
			]),
			msg
		], 'cbi-modal');
	},

	restoreBackup(data, confs) {
		window.clearTimeout(this.stageTimer);
		this.stageTimer = null;
		this.dirty = false;
		ui.showModal(_('Restoring…'), [ E('p', { 'class': 'spinning' }, [ _('Writing the configuration…') ]) ]);

		/*
		 * Step 1 removes every section, step 2 recreates all sections in the
		 * backup's order. Separate saves avoid uci.js mixing deletes and
		 * creates of the same names in one request.
		 */
		for (const conf of confs)
			for (const sec of this.partSections(conf))
				uci.remove(conf, sec['.name']);

		return uci.save().then(() => {
			for (const conf of confs) {
				for (const sec of data.configs[conf]) {
					const sid = sec['.anonymous'] ? uci.add(conf, sec['.type']) : uci.add(conf, sec['.type'], sec['.name']);
					for (const k in sec)
						if (k.charAt(0) != '.')
							uci.set(conf, sid, k, sec[k]);
				}
			}
			return uci.save();
		}).then(() => {
			/* missing table names first, so netifd can resolve the restored rules */
			if (confs.includes('network') && data.rt_tables)
				return this.addRtTables(data.rt_tables);
		}).then(() => {
			this.dirty = false;
			ui.hideModal();
			/* standard apply with rollback; the page reloads afterwards */
			return ui.changes.apply(true);
		}).catch(e => {
			ui.showModal(_('Restore failed'), [
				E('p', { 'class': 'fwd-problem' }, [ String(e && e.message || e) ]),
				E('p', [ _('Nothing was applied. Use "Reset" or revert the pending changes to return to the previous state.') ]),
				E('div', { 'class': 'fwd-dialog-buttons' }, [ E('button', { 'class': 'cbi-button', 'click': () => window.location.reload() }, [ _('Reload') ]) ])
			]);
		});
	},

	renderBackup() {
		const fileInput = E('input', { 'type': 'file', 'accept': '.json,application/json', 'style': 'display:none' });
		fileInput.addEventListener('change', () => {
			const f = fileInput.files && fileInput.files[0];
			if (!f) return;
			f.text().then(txt => {
				let data = null;
				try { data = JSON.parse(txt); } catch (e) {}
				this.restoreDialog(data, f.name);
			});
			fileInput.value = '';
		});

		dom.content(this.backupPane, [
			E('div', { 'class': 'cbi-section' }, [
				E('h4', [ _('Download backup') ]),
				E('p', [ _('Saves /etc/config/firewall (zones, forwardings, all rules and port forwards, IP sets), /etc/config/fwdesktop (objects, connections, services, layout, colours, settings) and the routing rules and static routes of /etc/config/network with their table names from /etc/iproute2/rt_tables into one file.') ]),
				this.dirty ? E('p', { 'class': 'fwd-problem' }, [ _('There are unsaved changes on this page; they are included in the backup. Press "Save & Apply" first if you want a backup of the active configuration.') ]) : '',
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, () => this.downloadBackup()) }, [ _('Download backup') ])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h4', [ _('Restore backup') ]),
				E('p', [ _('Restores the parts you choose from a backup file. You see a summary before anything is changed, and the restore is applied with rollback protection.') ]),
				fileInput,
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': () => fileInput.click() }, [ _('Choose backup file…') ])
			]),
			E('p', { 'class': 'cbi-section-descr' }, [ _('Note: files referenced by the firewall configuration (include scripts, IP set load files) are not part of the backup.') ])
		]);
	},

	renderSets() {
		const sets = uci.sections('firewall', 'ipset');
		const rows = sets.map(st => {
			const entries = fwm.toList(st.entry);
			const objs = this.setObjectUsers(st.name), rules = this.setRuleUsers(st.name);
			return E('tr', { 'class': 'tr' + (st.enabled == '0' ? ' disabled' : '') }, [
				E('td', { 'class': 'td' }, [ E('strong', [ st.name || '?' ]), st.comment ? E('div', { 'class': 'fwd-tip-sub' }, [ st.comment ]) : '' ]),
				E('td', { 'class': 'td' }, [ (st.family == 'ipv6' || st.family == '6') ? 'IPv6' : 'IPv4' ]),
				E('td', { 'class': 'td' }, [ fwm.toList(st.match).join(', ') || '-' ]),
				E('td', { 'class': 'td' }, [
					entries.length ? _('%d entries').format(entries.length) : '',
					entries.length ? E('div', { 'class': 'fwd-tip-sub fwd-mono' }, [ trunc(entries.slice(0, 3).join(', '), 48) ]) : '',
					st.loadfile ? E('div', [ _('from file %s').format(st.loadfile) ]) : '',
					(!entries.length && !st.loadfile) ? E('em', [ _('empty (filled at runtime)') ]) : ''
				]),
				E('td', { 'class': 'td' }, [
					[ objs.length ? _('%d desktop object(s)').format(objs.length) : '', rules.length ? _('%d other rule(s)').format(rules.length) : '' ].filter(Boolean).join(', ') || '-'
				]),
				E('td', { 'class': 'td fwd-actions' }, [
					this.smallBtn(_('Edit'), 'cbi-button-edit', () => this.editSet(st['.name'])),
					this.smallBtn(_('Delete'), 'cbi-button-remove', () => this.deleteSet(st['.name']))
				])
			]);
		});

		dom.content(this.setPane, [
			E('p', { 'class': 'cbi-section-descr' }, [ _('IP sets are named lists of addresses, networks, MACs or ports kept by the firewall (fw4). Use them on the desktop with "+ IP set". Changes are written to /etc/config/firewall when you press Save & Apply.') ]),
			this.table([ _('Name'), _('Family'), _('Match'), _('Entries'), _('Used by'), '' ], rows, _('No IP sets yet.')),
			E('div', { 'class': 'fwd-toolbar' }, [ this.smallBtn(_('+ New IP set'), 'cbi-button-add', () => this.editSet(null)) ])
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
		return this.stage().then(() => this.refresh());
	},

	writeUci() {
		const owned = s => [ 'object', 'service', 'connection' ].includes(s['.type']);

		if (!uci.get('fwdesktop', 'global'))
			uci.add('fwdesktop', 'global', 'global');

		this.applyOps('fwdesktop', fwm.diffSections(uci.sections('fwdesktop'), fwm.toSections(this.model), owned));

		const gen = fwm.generate(this.model);
		this.applyOps('firewall', fwm.diffSections(uci.sections('firewall'), gen.sections, fwm.isOwnedFirewallSection));

		/*
		 * Save in two steps. uci.js maps the names of newly created sections
		 * by position in its task list, which goes wrong when the same save
		 * also removes options; a reorder in that save then sends bogus
		 * section names and uci/order fails. So: first write all content,
		 * then (on the reloaded state) fix the section order separately.
		 */
		return uci.save().then(() => {
			let moved = false;

			/* generated firewall sections in connection order, after hand written ones */
			const want = gen.sections.map(s => s['.name']);
			const have = uci.sections('firewall').filter(fwm.isOwnedFirewallSection).map(s => s['.name']);
			if (want.join(' ') != have.join(' ')) {
				for (const name of want)
					uci.move('firewall', name, null);
				moved = true;
			}

			/* connection order is the order of the connection sections in fwdesktop */
			const order = fwm.connectionOrder(this.model);
			const cur = uci.sections('fwdesktop', 'connection').map(s => s['.name']);
			if (order.join(' ') != cur.join(' ')) {
				for (const name of order)
					uci.move('fwdesktop', name, null);
				moved = true;
			}

			return moved ? uci.save() : null;
		});
	},

	/* discard pending (not yet applied) changes, like LuCI's "Revert" */
	handleReset(ev) {
		window.clearTimeout(this.stageTimer);
		this.stageTimer = null;
		ui.showModal(_('Discard changes'), [
			E('p', [ _('Discard all changes that have not been applied yet? This reverts the pending changes of every LuCI page, not only this one.') ]),
			E('div', { 'class': 'fwd-dialog-buttons' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': () => { ui.hideModal(); ui.changes.revert(); } }, [ _('Discard') ])
			])
		]);
	}
});
