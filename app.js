(function () {
'use strict';

var VAT = 1.21;
var CODE = '6012';
var LS = 'cablare.local.v1';
var LSUI = 'cablare.ui.v1';
var PACKS = ['buc', 'set', 'rolă', 'volum'];
var UNITS = ['buc', 'm', 'l', 'ml', 'kg', 'coală'];
var DATA = { produse: [], preturi: { actualizat: null, surse: {}, variatie: {} } };

var S = {
  q: '', vat: false, dark: false, edit: false, open: {}, cats: {}, packs: {}, pmin: '', pmax: '', fresh: false,
  sort: null, dir: 1, panel: false, view: 'catalog', confirm: null, toast: null, dlg: null, form: null,
  local: { archived: {}, rej: {}, manual: {}, added: [], edited: {} }, items: [], loadError: ''
};

// ---------- utilitare ----------
function $(s) { return document.querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function norm(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/,/g, '.'); }
function grp(n, d) {
  var neg = n < 0, parts = Math.abs(n).toFixed(d).split('.');
  var i = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + i + (parts[1] ? ',' + parts[1] : '');
}
function money(n) { return grp(n, 2); }
function unitFmt(n) { return grp(n, n < 1 ? 3 : 2); }
function deN(n, one, many) {
  if (n === 1) return '1 ' + one;
  var r = n % 100;
  return n + ((r >= 20 || (r === 0 && n > 0)) ? ' de ' : ' ') + many;
}
function parseNum(s) {
  var t = String(s == null ? '' : s).trim().replace(',', '.');
  if (t === '') return null;
  var n = parseFloat(t);
  return isNaN(n) ? null : n;
}
function cmp(a, b) { return a === b ? 0 : (a < b ? -1 : 1); }
function safeUrl(u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
function startDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function dayDiff(iso) { return Math.round((startDay(new Date()) - startDay(new Date(iso))) / 86400000); }
function hhmm(iso) { var d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function agoWords(d) { return d <= 0 ? 'azi' : (d === 1 ? 'ieri' : 'acum ' + d + ' zile'); }
function ageInfo(s) {
  if (!s || !s.ver) return { min: 1e12, short: '—', long: '—', stale: false };
  var d = dayDiff(s.ver), hasT = String(s.ver).indexOf('T') > -1;
  var long = d <= 0 ? (hasT ? 'azi, ' + hhmm(s.ver) : 'azi') : (d === 1 ? 'ieri' : 'acum ' + d + ' zile');
  return { min: d * 1440 + 1, days: d, short: agoWords(d), long: long, stale: d > 3 };
}
function median(xs) {
  if (!xs.length) return null;
  var a = xs.slice().sort(function (x, y) { return x - y; }), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function ls(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
}

// ---------- date ----------
function loadLocal() {
  var o = {};
  try { o = JSON.parse(ls(LS) || '{}') || {}; } catch (e) { o = {}; }
  S.local = { archived: o.archived || {}, rej: o.rej || {}, manual: o.manual || {}, added: o.added || [], edited: o.edited || {} };
}
function saveLocal() { ls(LS, JSON.stringify(S.local)); }
function saveUi() { ls(LSUI, JSON.stringify({ dark: S.dark, vat: S.vat })); }

function packLabel(qty, unit, has) {
  if (!has) return '—';
  var qs = grp(qty, qty % 1 ? 2 : 0).replace(/,00$/, '');
  if (unit === 'buc') return qty === 1 ? '1 buc' : 'set ' + qs + ' buc';
  if (unit === 'm') return 'rolă ' + qs + ' m';
  if (unit === 'l') return 'flacon ' + qs + ' l';
  if (unit === 'coală') return 'set ' + qs + ' coli';
  return qs + ' ' + unit;
}
function packType(qty, unit, has) {
  if (!has) return 'buc';
  if (unit === 'l' || unit === 'ml') return 'volum';
  if (unit === 'm') return 'rolă';
  return qty > 1 ? 'set' : 'buc';
}

function buildItems() {
  var L = S.local, all = DATA.produse.concat(L.added);
  S.items = all.map(function (p) {
    var e = L.edited[p.id] || {};
    var name = e.denumire != null ? e.denumire : p.denumire;
    var cat = e.categorie != null ? e.categorie : p.categorie;
    var qtyRaw = 'ambalaj_cantitate' in e ? e.ambalaj_cantitate : p.ambalaj_cantitate;
    var unitRaw = 'ambalaj_unitate' in e ? e.ambalaj_unitate : p.ambalaj_unitate;
    var has = qtyRaw != null && qtyRaw > 0;
    var qty = has ? qtyRaw : 1, unit = has ? (unitRaw || 'buc') : 'buc';
    var src = [];
    (DATA.preturi.surse[p.id] || []).forEach(function (s) {
      var key = s.nume + '|' + (s.url || '');
      src.push({ key: key, nume: s.nume, url: safeUrl(s.url), price: s.pret == null ? null : s.pret, ver: s.verificat || null, manual: false, rej: !!L.rej[p.id + '|' + key] });
    });
    (L.manual[p.id] || []).forEach(function (s) {
      var key = 'm:' + s.id;
      src.push({ key: key, sid: s.id, nume: s.nume, url: safeUrl(s.url), price: s.pret == null ? null : s.pret, ver: s.verificat || null, manual: true, rej: !!L.rej[p.id + '|' + key] });
    });
    var it = {
      id: p.id, cat: cat, name: name, qty: qty, unit: unit, has: has, pack: packLabel(qty, unit, has), ptype: packType(qty, unit, has),
      ansamblu: !!p.ansamblu, note: p.de_verificat || '', code: e.code != null ? e.code : (p.code || ''), excl: e.excl != null ? e.excl : (p.excl || ''),
      delta: (DATA.preturi.variatie || {})[p.id] || 0, src: src,
      archived: !!L.archived[p.id], archAt: L.archived[p.id] || null
    };
    it.key = norm(it.name + ' ' + it.pack + ' ' + it.cat + ' ' + it.code);
    return it;
  });
}
function activeSrc(it) {
  return it.src.filter(function (s) { return !s.rej && s.price != null; }).sort(function (a, b) { return a.price - b.price; });
}
function cats() {
  var seen = {}, out = [];
  S.items.forEach(function (it) { if (!seen[it.cat]) { seen[it.cat] = 1; out.push(it.cat); } });
  return out;
}

var SORTS = {
  name: { label: 'Denumire', text: true, v: function (it) { return norm(it.name); } },
  pack: { label: 'Ambalaj', v: function (it) { return PACKS.indexOf(it.ptype) * 1e6 + it.qty; } },
  pp: { label: 'Preț ambalaj', v: function (it) { var a = activeSrc(it); return a.length ? a[0].price : 1e12; } },
  unit: { label: 'Preț / unitate', v: function (it) { var a = activeSrc(it); return a.length ? a[0].price / it.qty : 1e12; } },
  range: { label: 'Min–Max', v: function (it) { var a = activeSrc(it); return a.length ? a[a.length - 1].price : 1e12; } },
  nsrc: { label: 'Surse', v: function (it) { return activeSrc(it).length; } },
  age: { label: 'Actualizat', v: function (it) { return ageInfo(activeSrc(it)[0]).min; } }
};

function ctx() {
  var pmin = parseNum(S.pmin), pmax = parseNum(S.pmax);
  return {
    terms: norm(S.q).split(/\s+/).filter(Boolean), cats: S.cats, packs: S.packs,
    catOn: Object.keys(S.cats).length > 0, packOn: Object.keys(S.packs).length > 0,
    pmin: pmin, pmax: pmax, fresh: S.fresh, mult: S.vat ? VAT : 1
  };
}
function pass(it, c, except) {
  if (except !== 'q' && !c.terms.every(function (t) { return it.key.indexOf(t) !== -1; })) return false;
  if (except !== 'cat' && c.catOn && !c.cats[it.cat]) return false;
  if (except !== 'pack' && c.packOn && !c.packs[it.ptype]) return false;
  var act = activeSrc(it);
  if (except !== 'price' && (c.pmin !== null || c.pmax !== null)) {
    if (!act.length) return false;
    var u = Math.round(act[0].price * c.mult / it.qty * 1000) / 1000;
    if (c.pmin !== null && u < c.pmin) return false;
    if (c.pmax !== null && u > c.pmax) return false;
  }
  if (except !== 'fresh' && c.fresh && !(act.length && !ageInfo(act[0]).stale)) return false;
  return true;
}

// ---------- randare ----------
function renderAll() {
  renderHeader(); renderPanel(); renderContent(); renderToast(); renderDlg();
}

function renderHeader() {
  var app = $('#app');
  app.classList.toggle('dark', S.dark);
  app.classList.toggle('panel-open', S.panel);
  app.classList.toggle('edit', S.edit);
  $('#band').innerHTML = S.edit ? '<div class="band" role="status"><span class="bt">Mod editare activ <span class="bn">· modificările se salvează pe acest browser</span></span><button type="button" data-act="exit">Ieși</button></div>' : '';
  $('#addwrap').hidden = !S.edit;
  $('#vat0').setAttribute('aria-pressed', String(!S.vat));
  $('#vat1').setAttribute('aria-pressed', String(S.vat));
  var lbl = S.dark ? 'Treci la modul luminos' : 'Treci la modul întunecat';
  $('#themebtn').setAttribute('aria-label', lbl); $('#themebtn').title = lbl;
  var up = DATA.preturi.actualizat, long, short;
  if (up) {
    var d = dayDiff(up), t = ', ' + hhmm(up);
    long = 'Prețuri actualizate ' + agoWords(d) + t; short = 'Actualizat ' + agoWords(d) + t;
  } else { long = 'Prețuri: încă neactualizate automat'; short = 'Neactualizat'; }
  $('#meta').innerHTML = '<span class="m-long">' + esc(long) + '</span><span class="m-short">' + esc(short) + '</span>';
  $('#filtbtn').setAttribute('aria-expanded', String(S.panel));
  var n = activeChips().length;
  $('#filtbtn').textContent = n ? 'Filtre (' + n + ')' : 'Filtre';
}

function activeChips() {
  var out = [];
  Object.keys(S.cats).forEach(function (k) { out.push({ label: k, aria: 'Elimină filtrul ' + k, act: 'rm-cat', v: k }); });
  Object.keys(S.packs).forEach(function (k) { out.push({ label: 'Ambalaj: ' + k, aria: 'Elimină filtrul ambalaj ' + k, act: 'rm-pack', v: k }); });
  if (S.pmin || S.pmax) out.push({ label: 'Preț/unitate: ' + (S.pmin || '0') + '–' + (S.pmax || '∞'), aria: 'Elimină filtrul de preț', act: 'rm-price', v: '' });
  if (S.fresh) out.push({ label: 'Actualizat ≤ 3 zile', aria: 'Elimină filtrul de actualizare', act: 'rm-fresh', v: '' });
  return out;
}

function counts() {
  var c = ctx(), live = S.items.filter(function (it) { return !it.archived; });
  var shown = live.filter(function (it) { return pass(it, c); });
  return { c: c, live: live, shown: shown };
}

function renderPanel() {
  var k = counts(), c = k.c, live = k.live;
  var catH = cats().map(function (name) {
    var n = live.filter(function (it) { return it.cat === name && pass(it, c, 'cat'); }).length;
    return '<label class="ck' + (n ? '' : ' zero') + '"><input type="checkbox" data-in="cat" data-v="' + esc(name) + '"' + (S.cats[name] ? ' checked' : '') + '><span class="ck-n">' + esc(name) + '</span><span class="cnt">' + n + '</span></label>';
  }).join('');
  var packH = PACKS.map(function (p) {
    var n = live.filter(function (it) { return it.ptype === p && pass(it, c, 'pack'); }).length;
    return '<label class="ck' + (n ? '' : ' zero') + '"><input type="checkbox" data-in="pack" data-v="' + p + '"' + (S.packs[p] ? ' checked' : '') + '><span class="ck-n">' + p + '</span><span class="cnt">' + n + '</span></label>';
  }).join('');
  var freshN = live.filter(function (it) { return pass(it, c, 'fresh') && (function () { var a = activeSrc(it); return a.length && !ageInfo(a[0]).stale; })(); }).length;
  var noFilters = !activeChips().length && !S.q;
  var h = '<div class="ph"><span class="ph-t">Filtre</span><button type="button" class="ph-x" data-act="panel-close">Închide</button></div>' +
    '<div class="pbody">' +
    '<div class="fcount" aria-live="polite"><strong>' + k.shown.length + '</strong> din ' + live.length + '</div>' +
    '<button type="button" class="reset" data-act="reset"' + (noFilters ? ' disabled' : '') + '>Resetează filtrele</button>' +
    '<fieldset class="fg"><legend>Categorie</legend>' + catH + '</fieldset>' +
    '<fieldset class="fg"><legend>Preț / unitate (lei)</legend><div class="range">' +
    '<label class="rl"><span class="sr">Preț minim pe unitate</span><input class="rin" type="text" inputmode="decimal" placeholder="min" value="' + esc(S.pmin) + '" data-in="pmin"></label><span aria-hidden="true">–</span>' +
    '<label class="rl"><span class="sr">Preț maxim pe unitate</span><input class="rin" type="text" inputmode="decimal" placeholder="max" value="' + esc(S.pmax) + '" data-in="pmax"></label></div>' +
    '<div class="fnote">' + (S.vat ? 'Valori cu TVA (21%).' : 'Valori fără TVA.') + '</div></fieldset>' +
    '<fieldset class="fg"><legend>Tip ambalaj</legend>' + packH + '</fieldset>' +
    '<fieldset class="fg"><legend>Actualizare preț</legend><label class="ck"><input type="checkbox" data-in="fresh"' + (S.fresh ? ' checked' : '') + '><span class="ck-n">Doar prețuri actualizate în ultimele 3 zile</span><span class="cnt">' + freshN + '</span></label></fieldset>';
  if (S.edit) {
    var archN = S.items.filter(function (it) { return it.archived; }).length;
    h += '<button type="button" class="arch-link" data-act="archive">Arhivă (' + archN + ')</button>' +
      '<fieldset class="fg"><legend>Copie de siguranță</legend><button type="button" class="bk" data-act="export">Descarcă modificările</button><button type="button" class="bk" data-act="import">Încarcă modificări</button><input type="file" id="impfile" accept="application/json,.json" hidden></fieldset>';
  }
  h += '<div class="legend"><span class="lg-stale">Portocaliu</span> = preț neactualizat de peste 3 zile.<br><span class="lg-rise">▲</span> <span class="lg-fall">▼</span> = variație față de ieri.</div></div>' +
    '<div class="pfoot"><button type="button" class="show" data-act="panel-close">Arată ' + deN(k.shown.length, 'rezultat', 'rezultate') + '</button></div>';
  $('#fpanel').innerHTML = h;
}

function sortedRows(list) {
  if (!S.sort) return list;
  var s = SORTS[S.sort], dir = S.dir;
  return list.slice().sort(function (a, b) {
    var r = cmp(s.v(a), s.v(b)) * dir;
    return r || cmp(norm(a.name), norm(b.name));
  });
}

function renderContent() {
  var el = $('#content');
  if (S.loadError) { el.innerHTML = '<div class="err-load" role="alert">' + esc(S.loadError) + '</div>'; return; }
  if (S.view === 'archive') { el.innerHTML = archiveHtml(); return; }
  var k = counts(), c = k.c, mult = c.mult, chips = activeChips();
  var barCls = 'chipsbar' + (chips.length ? '' : ' none');
  var h = '<div class="' + barCls + '" aria-label="Filtre active">';
  chips.forEach(function (a) { h += '<button type="button" class="fchip" data-act="' + a.act + '" data-v="' + esc(a.v) + '" aria-label="' + esc(a.aria) + '">' + esc(a.label) + '<span class="x" aria-hidden="true">×</span></button>'; });
  if (chips.length > 1) h += '<button type="button" class="clearall" data-act="clearall">Șterge tot</button>';
  if (!chips.length) h += '<span class="hint">Niciun filtru activ</span>';
  h += '<span class="bar-info">' + k.shown.length + ' din ' + k.live.length + ' · lei, ' + (S.vat ? 'cu TVA' : 'fără TVA') + '</span></div>';
  h += '<main class="body" aria-label="Listă de prețuri"><div class="thead"><div class="cols th">';
  ['name', 'pack', 'pp', 'unit', 'range', 'nsrc', 'age'].forEach(function (key) {
    var on = S.sort === key, ind = on ? (S.dir > 0 ? '▲' : '▼') : '↕';
    var aria = 'Sortează după ' + SORTS[key].label.toLowerCase() + (on ? (S.dir > 0 ? ', crescător' : ', descrescător') : '');
    var num = (key === 'name' || key === 'pack' || key === 'age') ? '' : ' class="num"';
    h += '<span' + num + '><button type="button" class="sbtn" data-act="sort" data-v="' + key + '" aria-label="' + esc(aria) + '">' + SORTS[key].label + '<span class="sind' + (on ? ' on' : '') + '">' + ind + '</span></button></span>';
  });
  h += '</div></div>';
  var rows = sortedRows(k.shown);
  rows.forEach(function (it, i) { h += rowHtml(it, i, mult); });
  if (!rows.length) h += '<div class="empty">Niciun produs nu corespunde căutării și filtrelor.<button type="button" data-act="clearall">Șterge tot</button></div>';
  h += '<div class="foot">Prețuri în lei, ' + (S.vat ? 'cu TVA' : 'fără TVA') + '. Preț / unitate = cel mai mic preț de ambalaj ÷ cantitatea din ambalaj. Apasă pe antetul unei coloane pentru sortare și pe un rând pentru surse.</div></main>';
  el.innerHTML = h;
}

function rowHtml(it, i, mult) {
  var act = activeSrc(it), best = act[0], worst = act[act.length - 1], info = ageInfo(best);
  var open = !!S.open[it.id], has = !!best;
  var unitCell;
  if (has) {
    var dT = (it.delta > 0 ? '+' : '') + grp(it.delta, 1) + '%';
    unitCell = (info.stale ? '<span class="stale-tag" title="Preț neactualizat de ' + info.days + ' zile">' + info.days + ' zile</span>' : '') +
      '<span class="dslot">' + (it.delta > 0 ? '<span class="rise" title="Față de ieri: ' + dT + '"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1L9.5 9H.5z" fill="currentColor"></path></svg><span class="sr">Față de ieri: ' + dT + '</span></span>' : '') +
      (it.delta < 0 ? '<span class="fall" title="Față de ieri: ' + dT + '"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9L.5 1h9z" fill="currentColor"></path></svg><span class="sr">Față de ieri: ' + dT + '</span></span>' : '') + '</span>' +
      '<span class="price' + (info.stale ? ' is-stale' : '') + '">' + unitFmt(best.price * mult / it.qty) + '</span><span class="u">/' + esc(it.unit) + '</span>';
  } else unitCell = '<span class="seeking">fără preț</span>';
  var h = '<div class="item' + (i % 2 ? ' odd' : '') + (open ? ' open' : '') + '"><div class="rline">' +
    '<button type="button" class="cols row" aria-expanded="' + open + '" data-act="toggle" data-id="' + esc(it.id) + '">' +
    '<span class="c-name"><span class="clamp">' + esc(it.name) + (it.ansamblu ? '<span class="tag">ansamblu</span>' : '') + '</span></span>' +
    '<span class="c-pack"><span class="pk-txt">' + esc(it.pack) + '</span></span>' +
    '<span class="c-pp num">' + (has ? money(best.price * mult) : '—') + '</span>' +
    '<span class="c-unit num">' + unitCell + '</span>' +
    '<span class="c-range num">' + (act.length > 1 ? money(best.price * mult) + '–' + money(worst.price * mult) : (has ? money(best.price * mult) : '—')) + '</span>' +
    '<span class="c-src num">' + act.length + '</span>' +
    '<span class="c-age' + (info.stale ? ' is-stale' : '') + '">' + esc(info.short) + '</span></button></div>';
  if (open) h += detailHtml(it, act, mult);
  return h + '</div>';
}

function detailHtml(it, act, mult) {
  var edit = S.edit, med = median(act.map(function (s) { return s.price; }));
  var disp = it.src.slice().filter(function (s) { return edit || !s.rej; })
    .sort(function (a, b) { return (a.rej - b.rej) || ((a.price == null) - (b.price == null)) || (a.price - b.price); });
  var rejN = it.src.filter(function (s) { return s.rej; }).length;
  var summary;
  if (!it.src.length) summary = 'Nicio sursă încă.' + (edit ? '' : ' Prețurile vor apărea după prima actualizare.');
  else if (!act.length) summary = 'Fără preț verificat. Linkurile rămân în listă pentru acces rapid.';
  else summary = 'Mediană: ' + money(med * mult) + ' lei / ambalaj · ' + deN(act.length, 'sursă activă', 'surse active') + (edit && rejN ? ' · ' + deN(rejN, 'respinsă', 'respinse') : '') + ' · ' + (it.delta === 0 ? 'fără variație față de ieri' : 'față de ieri: ' + (it.delta > 0 ? '+' : '') + grp(it.delta, 1) + '%');
  var firstActive = disp.filter(function (s) { return !s.rej && s.price != null; })[0];
  var h = '<div class="detail' + (edit ? ' ed' : '') + '">';
  if (disp.length) {
    h += '<div class="scols srow shead"><span>Sursă</span><span>Verificat</span><span class="num">Preț ambalaj</span><span class="num">Preț / unitate</span><span>Link</span>' + (edit ? '<span></span>' : '') + '</div>';
    disp.forEach(function (s) {
      var si = ageInfo(s), pr = s.price != null;
      h += '<div class="scols srow' + (s.rej ? ' rej' : '') + '"><span class="s-name"><span class="s-nm">' + esc(s.nume) + '</span>' +
        (s.manual ? '<span class="tag">manual</span>' : '') + (!pr && !s.rej ? '<span class="tag">doar link</span>' : '') +
        (!s.rej && act.length > 1 && s === firstActive ? '<span class="best">cel mai mic</span>' : '') + (s.rej ? '<span class="rejtag">respinsă</span>' : '') + '</span>' +
        '<span class="' + (si.stale && !s.rej ? 'ago is-stale' : 'ago') + '">' + esc(si.long) + '</span>' +
        '<span class="s-pp num"><span class="mlbl">ambalaj </span>' + (pr ? money(s.price * mult) : '—') + '</span>' +
        '<span class="s-u num">' + (pr ? unitFmt(s.price * mult / it.qty) + '<span class="u">/' + esc(it.unit) + '</span>' : '—') + '</span>' +
        '<span class="s-link">' + (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" aria-label="Deschide oferta ' + esc(s.nume) + '">Deschide ↗</a>' : '<span class="nolink">fără link</span>') + '</span>';
      if (edit) {
        h += '<span class="s-act"><button type="button" class="mini" data-act="rej" data-id="' + esc(it.id) + '" data-k="' + esc(s.key) + '">' + (s.rej ? 'Reia' : 'Respinge') + '</button>' +
          (s.manual ? '<button type="button" class="mini" data-act="delsrc" data-id="' + esc(it.id) + '" data-k="' + esc(s.sid) + '">Șterge</button>' : '') + '</span>';
      }
      h += '</div>';
    });
  }
  h += '<div class="dnote">' + esc(summary) + '</div>';
  if (it.note) h += '<div class="dnote warn">De verificat: ' + esc(it.note) + '</div>';
  if (edit) {
    h += '<div class="actions">';
    if (S.confirm === it.id) h += '<div class="confirm" role="group" aria-label="Confirmare arhivare"><span>Arhivezi produsul?</span><button type="button" class="mini primary" data-act="do-archive" data-id="' + esc(it.id) + '">Da, arhivează</button><button type="button" class="mini" data-act="cancel-archive">Nu</button></div>';
    else h += '<button type="button" class="mini primary" data-act="addsrc" data-id="' + esc(it.id) + '">+ Adaugă sursă</button><button type="button" class="mini" data-act="edit" data-id="' + esc(it.id) + '">Editează</button><button type="button" class="mini" data-act="ask-archive" data-id="' + esc(it.id) + '">Arhivează</button>';
    h += '</div>';
  }
  return h + '</div>';
}

function archiveHtml() {
  var arch = S.items.filter(function (it) { return it.archived; }).sort(function (a, b) { return b.archAt - a.archAt; });
  var h = '<div class="chipsbar"><span class="arch-title">Arhivă</span><span class="cnt">' + deN(arch.length, 'produs', 'produse') + '</span><button type="button" class="clearall" data-act="back">← Înapoi la catalog</button></div>' +
    '<main class="body" aria-label="Produse arhivate"><div class="arow ahead"><span>Denumire</span><span>Ambalaj</span><span>Arhivat</span><span></span></div>';
  arch.forEach(function (it, i) {
    var d = dayDiff(it.archAt);
    h += '<div class="arow' + (i % 2 ? ' odd' : '') + '"><span class="a-n clamp">' + esc(it.name) + '</span><span class="a-p">' + esc(it.pack) + '</span><span class="a-w">' + esc(agoWords(d)) + '</span>' +
      '<span class="a-b"><button type="button" class="mini" data-act="restore" data-id="' + esc(it.id) + '" aria-label="Restaurează ' + esc(it.name) + '">Restaurează</button></span></div>';
  });
  if (!arch.length) h += '<div class="empty">Arhiva e goală.</div>';
  return h + '</main>';
}

function renderToast() {
  $('#toast').innerHTML = S.toast ? '<div class="toast" role="status">' + esc(S.toast.msg) + '<button type="button" data-act="undo">Anulează</button></div>' : '';
}

function opt(v, sel, label) { return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(label || v) + '</option>'; }

function renderDlg() {
  var el = $('#dlg'), f = S.form, d = S.dlg;
  if (!d) { el.innerHTML = ''; return; }
  var title, body, submit;
  if (d.indexOf('src:') === 0) {
    title = 'Adaugă sursă'; submit = 'Adaugă sursa';
    var names = {};
    DATA.produse.forEach(function (p) { (DATA.preturi.surse[p.id] || []).forEach(function (s) { names[s.nume] = 1; }); });
    S.items.forEach(function (it) { it.src.forEach(function (s) { names[s.nume] = 1; }); });
    body = '<div class="fld"><label class="fl" for="f-sn">Furnizor</label><input id="f-sn" class="inp" type="text" list="dl-nm" data-f="nume" value="' + esc(f.nume) + '" autocomplete="off"><datalist id="dl-nm">' +
      Object.keys(names).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist></div>' +
      '<div class="fld"><label class="fl" for="f-su">Link <span class="opt">(opțional)</span></label><input id="f-su" class="inp" type="url" inputmode="url" data-f="url" value="' + esc(f.url) + '" placeholder="https://…" autocomplete="off"></div>' +
      '<fieldset class="fld"><legend class="fl">Preț ambalaj <span class="opt">(opțional)</span></legend><div class="fh">Fără preț, linkul rămâne în listă pentru acces rapid, dar nu intră în minim, maxim sau mediană.</div><div class="two">' +
      '<label><span class="sub">Preț (lei)</span><input class="inp num" type="text" inputmode="decimal" data-f="pret" value="' + esc(f.pret) + '"></label>' +
      '<label><span class="sub">Prețul introdus e</span><select class="inp" data-f="tva">' + opt('cu', f.tva, 'cu TVA') + opt('fara', f.tva, 'fără TVA') + '</select></label></div></fieldset>';
  } else {
    title = d === 'add' ? 'Adaugă produs' : 'Editează produs'; submit = d === 'add' ? 'Adaugă produs' : 'Salvează';
    body = '<div class="fld"><label class="fl" for="f-name">Denumire completă</label><div class="fh" id="f-name-h">Exact cum apare în deviz.</div><textarea id="f-name" class="inp" rows="3" data-f="name" aria-describedby="f-name-h">' + esc(f.name) + '</textarea></div>' +
      '<div class="fld"><label class="fl" for="f-cat">Categorie</label><select id="f-cat" class="inp" data-f="cat">' + cats().map(function (c) { return opt(c, f.cat); }).join('') + '</select></div>' +
      '<fieldset class="fld"><legend class="fl">Ambalaj <span class="opt">(opțional)</span></legend><div class="two"><label><span class="sub">Cantitate</span><input class="inp num" type="text" inputmode="decimal" data-f="qty" value="' + esc(f.qty) + '"></label>' +
      '<label><span class="sub">Unitate</span><select class="inp" data-f="unit">' + UNITS.map(function (u) { return opt(u, f.unit); }).join('') + '</select></label></div></fieldset>' +
      '<div class="fld"><label class="fl" for="f-code">Cod producător <span class="opt">(opțional)</span></label><input id="f-code" class="inp" type="text" data-f="code" value="' + esc(f.code) + '" autocomplete="off"></div>' +
      '<div class="fld"><label class="fl" for="f-ex">Cuvinte de excludere <span class="opt">(opțional)</span></label><div class="fh" id="f-ex-h">Separate prin virgulă. Vor fi folosite la căutarea automată a prețurilor, când va fi activă.</div><input id="f-ex" class="inp" type="text" data-f="excl" value="' + esc(f.excl) + '" aria-describedby="f-ex-h" autocomplete="off"></div>';
  }
  el.innerHTML = '<div class="ovl"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><div class="dlg-h"><h2 id="dlg-t">' + esc(title) + '</h2></div><div class="dlg-b">' + body + '</div>' +
    '<div class="dlg-f"><button type="button" class="btn primary" id="dlg-ok" data-act="dlg-ok"' + (formValid() ? '' : ' disabled') + '>' + esc(submit) + '</button><button type="button" class="btn" data-act="dlg-close">Anulează</button></div></div></div>';
  var first = el.querySelector('input,textarea'); if (first) try { first.focus(); } catch (e) {}
}

function formValid() {
  var f = S.form, d = S.dlg;
  if (!f || !d) return false;
  if (d.indexOf('src:') === 0) {
    if (!f.nume.trim()) return false;
    var hasUrl = f.url.trim() !== '', hasPrice = f.pret.trim() !== '';
    if (!hasUrl && !hasPrice) return false;
    if (hasUrl && !safeUrl(/^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : 'https://' + f.url.trim())) return false;
    if (hasPrice) { var p = parseNum(f.pret); if (!(p > 0)) return false; }
    return true;
  }
  if (!f.name.trim()) return false;
  if (f.qty.trim() !== '' && !(parseNum(f.qty) > 0)) return false;
  return true;
}

// ---------- acțiuni ----------
function flip(field, key) { var o = S[field]; if (o[key]) delete o[key]; else o[key] = true; }
function toast(msg, id) {
  S.toast = { msg: msg, id: id };
  var t = S.toast;
  setTimeout(function () { if (S.toast === t) { S.toast = null; renderToast(); } }, 6000);
}
function findItem(id) { return S.items.filter(function (x) { return x.id === id; })[0]; }
function commit() { saveLocal(); buildItems(); renderAll(); }

function openAdd() {
  var c = cats();
  S.dlg = 'add'; S.form = { name: '', cat: c[0] || '', qty: '', unit: 'buc', code: '', excl: '' }; renderDlg();
}
function openEdit(id) {
  var it = findItem(id); if (!it) return;
  S.dlg = 'edit:' + id;
  S.form = { name: it.name, cat: it.cat, qty: it.has ? String(it.qty).replace('.', ',') : '', unit: it.unit, code: it.code, excl: it.excl };
  renderDlg();
}
function openSrc(id) { S.dlg = 'src:' + id; S.form = { nume: '', url: '', pret: '', tva: 'cu' }; renderDlg(); }
function closeDlg() { S.dlg = null; S.form = null; renderDlg(); }

function submitDlg() {
  if (!formValid()) return;
  var f = S.form, d = S.dlg;
  if (d.indexOf('src:') === 0) {
    var id = d.slice(4), url = f.url.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    var p = f.pret.trim() === '' ? null : parseNum(f.pret);
    if (p != null && f.tva === 'cu') p = Math.round(p / VAT * 100) / 100;
    var arr = S.local.manual[id] = S.local.manual[id] || [];
    arr.push({ id: 'm' + Date.now(), nume: f.nume.trim(), url: url, pret: p, verificat: p != null ? new Date().toISOString() : null });
    S.open[id] = true; S.dlg = null; S.form = null; commit(); return;
  }
  var qty = f.qty.trim() === '' ? null : parseNum(f.qty);
  var rec = { denumire: f.name.trim(), categorie: f.cat, ambalaj_cantitate: qty, ambalaj_unitate: qty == null ? null : f.unit, code: f.code.trim(), excl: f.excl.trim() };
  if (d === 'add') {
    var nid = 'n' + Date.now();
    rec.id = nid; rec.added = true;
    S.local.added.unshift(rec); S.open[nid] = true;
  } else {
    S.local.edited[d.slice(5)] = rec;
  }
  S.dlg = null; S.form = null; commit();
}

function doExport() {
  var blob = new Blob([JSON.stringify(S.local, null, 1)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'modificari-catalog-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
function doImport(file) {
  var r = new FileReader();
  r.onload = function () {
    try {
      var o = JSON.parse(r.result);
      if (!o || typeof o !== 'object') throw new Error('format');
      S.local = { archived: o.archived || {}, rej: o.rej || {}, manual: o.manual || {}, added: Array.isArray(o.added) ? o.added : [], edited: o.edited || {} };
      commit(); toast('Modificările au fost încărcate.', null);
      renderToast();
    } catch (e) { toast('Fișier invalid.', null); renderToast(); }
  };
  r.readAsText(file);
}

function act(a, el) {
  var id = el.getAttribute('data-id'), v = el.getAttribute('data-v'), k = el.getAttribute('data-k');
  switch (a) {
    case 'toggle': flip('open', id); renderContent(); return;
    case 'sort': if (S.sort === v) S.dir = -S.dir; else { S.sort = v; S.dir = 1; } renderContent(); return;
    case 'rm-cat': delete S.cats[v]; break;
    case 'rm-pack': delete S.packs[v]; break;
    case 'rm-price': S.pmin = ''; S.pmax = ''; break;
    case 'rm-fresh': S.fresh = false; break;
    case 'clearall': S.q = ''; $('#qc').value = ''; S.cats = {}; S.packs = {}; S.pmin = ''; S.pmax = ''; S.fresh = false; break;
    case 'reset': S.q = ''; $('#qc').value = ''; S.cats = {}; S.packs = {}; S.pmin = ''; S.pmax = ''; S.fresh = false; break;
    case 'vat0': S.vat = false; saveUi(); break;
    case 'vat1': S.vat = true; saveUi(); break;
    case 'theme': S.dark = !S.dark; saveUi(); break;
    case 'panel-open': S.panel = true; break;
    case 'panel-close': S.panel = false; break;
    case 'exit': S.edit = false; S.view = 'catalog'; S.confirm = null; S.dlg = null; S.form = null; break;
    case 'archive': S.view = 'archive'; S.panel = false; break;
    case 'back': S.view = 'catalog'; break;
    case 'add': openAdd(); return;
    case 'edit': openEdit(id); return;
    case 'addsrc': openSrc(id); return;
    case 'dlg-close': closeDlg(); return;
    case 'dlg-ok': submitDlg(); return;
    case 'ask-archive': S.confirm = id; break;
    case 'cancel-archive': S.confirm = null; break;
    case 'do-archive': S.local.archived[id] = Date.now(); delete S.open[id]; S.confirm = null; toast('Produs arhivat.', id); commit(); return;
    case 'undo': if (S.toast && S.toast.id) { delete S.local.archived[S.toast.id]; } S.toast = null; commit(); return;
    case 'restore': delete S.local.archived[id]; commit(); return;
    case 'rej': var rk = id + '|' + k; if (S.local.rej[rk]) delete S.local.rej[rk]; else S.local.rej[rk] = true; commit(); return;
    case 'delsrc': S.local.manual[id] = (S.local.manual[id] || []).filter(function (s) { return s.id !== k; }); delete S.local.rej[id + '|m:' + k]; commit(); return;
    case 'export': doExport(); return;
    case 'import': $('#impfile').click(); return;
  }
  renderAll();
}

// ---------- evenimente ----------
document.addEventListener('click', function (e) {
  var t = e.target.closest ? e.target.closest('[data-act]') : null;
  if (t) act(t.getAttribute('data-act'), t);
});
document.addEventListener('change', function (e) {
  var t = e.target, a = t.getAttribute && t.getAttribute('data-in');
  if (t.id === 'impfile' && t.files && t.files[0]) { doImport(t.files[0]); t.value = ''; return; }
  if (!a) {
    if (t.getAttribute && t.getAttribute('data-f')) { S.form[t.getAttribute('data-f')] = t.value; syncOk(); }
    return;
  }
  var v = t.getAttribute('data-v');
  if (a === 'cat') flip('cats', v);
  else if (a === 'pack') flip('packs', v);
  else if (a === 'fresh') S.fresh = t.checked;
  else if (a === 'pmin') S.pmin = t.value;
  else if (a === 'pmax') S.pmax = t.value;
  renderHeader(); renderPanel(); renderContent();
});
document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.id === 'qc') { S.q = t.value; renderHeader(); renderPanel(); renderContent(); return; }
  var f = t.getAttribute && t.getAttribute('data-f');
  if (f && S.form) { S.form[f] = t.value; syncOk(); }
});
function syncOk() { var b = $('#dlg-ok'); if (b) b.disabled = !formValid(); }
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && S.dlg) { closeDlg(); return; }
  if (e.target && e.target.id === 'qc' && e.key === 'Enter' && String(e.target.value).trim() === CODE) {
    e.preventDefault(); e.target.value = ''; S.q = ''; S.edit = true; renderAll();
  }
});

// ---------- pornire ----------
function init() {
  try { var u = JSON.parse(ls(LSUI) || '{}'); S.dark = !!u.dark; S.vat = !!u.vat; } catch (e) {}
  loadLocal();
  function get(path) { return fetch(path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); }); }
  Promise.all([get('data/produse.json'), get('data/preturi.json')]).then(function (res) {
    DATA.produse = res[0].produse || [];
    var p = res[1] || {};
    DATA.preturi = { actualizat: p.actualizat || null, surse: p.surse || {}, variatie: p.variatie || {} };
    buildItems(); renderAll();
    try { $('#qc').focus({ preventScroll: true }); } catch (e) {}
  }).catch(function () {
    S.loadError = 'Nu s-au putut încărca datele catalogului. Reîncarcă pagina sau încearcă mai târziu.';
    renderAll();
  });
  renderHeader();
}
init();
})();
