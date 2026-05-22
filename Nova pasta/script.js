/* ═══════════════════════════════════════════════════════════════
   IIE — Industrial Intelligence Engine
   Embalagens Tatuí — Estoque de Fios v3.2
   SCRIPT COMPLETO E DEFINITIVO
═══════════════════════════════════════════════════════════════ */

/* ── DATABASE ── */
const DB_NAME = 'etfios_v1', DB_VER = 3;
let db;

async function initDB() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VER);
        r.onupgradeneeded = e => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('threads'))
                d.createObjectStore('threads', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('counts')) {
                const s = d.createObjectStore('counts', { keyPath: 'id', autoIncrement: true });
                s.createIndex('threadId', 'threadId');
                s.createIndex('date', 'date');
            }
            if (!d.objectStoreNames.contains('days'))
                d.createObjectStore('days', { keyPath: 'date' });
        };
        r.onsuccess = e => {
            db = e.target.result;
            db.onversionchange = () => { db.close(); db = null; };
            res();
        };
        r.onerror = () => rej(r.error);
    });
}

async function ensureDB() {
    if (!db || db.readyState === 'done') await initDB();
}

async function safeTx(store, mode, fn) {
    await ensureDB();
    return new Promise((res, rej) => {
        try {
            const tx = db.transaction(store, mode);
            const os = tx.objectStore(store);
            const req = fn(os);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
            tx.onerror = () => rej(tx.error);
        } catch (err) { rej(err); }
    });
}

const dbGet = (s, k) => safeTx(s, 'readonly', os => os.get(k));
const dbAll = (s) => safeTx(s, 'readonly', os => os.getAll());
const dbPut = (s, d) => safeTx(s, 'readwrite', os => os.put(d));
const dbDel = (s, k) => safeTx(s, 'readwrite', os => os.delete(k));

async function dbPutBatch(store, records) {
    await ensureDB();
    if (!records.length) return [];
    return new Promise((res, rej) => {
        try {
            const tx = db.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            let done = 0;
            records.forEach((rec, i) => {
                const req = os.put(rec);
                req.onsuccess = () => {
                    rec.id = req.result;
                    if (++done === records.length) res(records);
                };
                req.onerror = () => rej(req.error);
            });
            tx.onerror = () => rej(tx.error);
        } catch (err) { rej(err); }
    });
}

/* ── STATE ── */
let threads = [], counts = [], daysMeta = {};
let curFilter = 'all', editingThread = null, activeThread = null;
let cntH = 0, cntL = 0, cntProd = 0, cntStack = [];
let calYear, calMonth, calView = 'month', repPeriod = 'day';
let detChartIns = null, consChartIns = null, repChartIns = null;
let activePage = 'dash';

/* ── UTILS ── */

/**
 * Normaliza QUALQUER representação de data para "YYYY-MM-DD" local.
 * Aceita: "2025-05-01", "2025-05-01T08:00:00.000Z", Date, null/undefined.
 * NUNCA usa UTC para extrair dia — sempre interpreta como local.
 */
function toYMD(input) {
    if (!input) return null;
    if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    const d = (input instanceof Date) ? input : new Date(
        typeof input === 'string'
            ? input.replace(/T.*$/, 'T12:00:00')
            : input
    );
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dy}`;
}

// Data de hoje no fuso local — usa o relógio real do dispositivo
const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Subtrai n dias de uma string YYYY-MM-DD (operação local, sem UTC)
function subtractDays(dateStr, n = 1) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
const subtractDay = ds => subtractDays(ds, 1);

// Últimos n dias em ordem cronológica
function lastNDays(n) {
    const a = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        a.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return a;
}
const last7 = () => lastNDays(7);

const fmtDate = s => {
    if (!s) return '--';
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
};
const fmtKg = n => (n === null || n === undefined || isNaN(n)) ? '--' : n.toFixed(1) + ' kg';
const fmtN = n => (n === null || n === undefined || isNaN(n)) ? '--' : parseFloat(n.toFixed(1)).toLocaleString('pt-BR');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const vib = p => navigator.vibrate && navigator.vibrate(p || 20);

/* Normaliza o array counts em memória */
function normalizeCounts() {
    counts = counts.map(c => ({ ...c, date: toYMD(c.date) || c.date }));
}

let _toastT;
function toast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    const ic = { ok: 'fa-check', err: 'fa-xmark', info: 'fa-circle-info' };
    el.querySelector('i').className = 'fa ' + (ic[type] || 'fa-check');
    document.getElementById('toast-txt').textContent = msg;
    el.className = 'toast ' + type + ' visible';
    clearTimeout(_toastT);
    _toastT = setTimeout(() => el.classList.remove('visible'), 2800);
}

/* ── TOGGLE SECTIONS ── */
function toggleSection(id) {
    const body = document.getElementById(id);
    const chev = document.getElementById('chev-' + id);
    const open = body.classList.contains('open');
    body.classList.toggle('open', !open);
    body.style.display = open ? 'none' : 'block';
    if (chev) chev.classList.toggle('open', !open);
}

/* ── NAVIGATION ── */
const PAGE_TITLES = { dash: 'Dashboard', count: 'Contagem', stock: 'Estoque', cal: 'Calendario', rep: 'Relatorios' };

function navTo(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pg = document.getElementById('pg-' + page);
    if (pg) pg.classList.add('active');
    document.querySelectorAll('.nav-item[data-page], .mob-nav-item[data-page]')
        .forEach(n => n.classList.remove('active'));
    document.querySelectorAll('[data-page="' + page + '"]')
        .forEach(n => n.classList.add('active'));
    document.getElementById('topbar-title').textContent = PAGE_TITLES[page] || '';
    activePage = page;
    closeSidebar();
    if (page === 'dash') renderDash();
    if (page === 'count') renderCountPage();
    if (page === 'stock') renderStock();
    if (page === 'cal') renderCal();
    if (page === 'rep') renderReports();
}

/* ── SIDEBAR ── */
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
}

/* ── SHEETS ── */
function openSheet(id) {
    document.getElementById('overlay').classList.add('open');
    document.getElementById(id).classList.add('open');
}
function closeSheet() {
    document.getElementById('overlay').classList.remove('open');
    document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
}

/* ══════════════════════════════════════════════════════════════
   IIE — Industrial Intelligence Engine
══════════════════════════════════════════════════════════════ */
const IIE = {

    tc(tid) {
        return counts
            .filter(c => c.threadId === tid)
            .sort((a, b) => a.date.localeCompare(b.date));
    },

    latest(tid) { const t = this.tc(tid); return t.length ? t[t.length - 1] : null; },
    prev(tid) { const t = this.tc(tid); return t.length >= 2 ? t[t.length - 2] : null; },

    avgDaily(tid) {
        const t = this.tc(tid);
        if (t.length < 2) return null;
        const cs = [];
        for (let i = 1; i < t.length; i++) {
            const delta = t[i - 1].stockKg - t[i].stockKg;
            if (delta > 0.1) cs.push(delta);
        }
        return cs.length ? cs.reduce((a, b) => a + b) / cs.length : null;
    },

    daysLeft(tid) {
        const l = this.latest(tid);
        if (!l) return null;
        const a = this.avgDaily(tid);
        return (a && a > 0) ? Math.round(l.stockKg / a) : null;
    },

    status(tid) {
        const l = this.latest(tid);
        if (!l) return 'no-data';
        const tc = this.tc(tid);
        if (tc.length >= 3) {
            const l3 = tc.slice(-3);
            if (l3.every(c => Math.abs(c.stockKg - l3[0].stockKg) < 0.5)) return 'stopped';
        }
        const d = this.daysLeft(tid);
        if (d === null) return 'normal';
        if (d <= 3) return 'critical';
        if (d <= 7) return 'low';
        return 'normal';
    },

    cls(tid) {
        const a = this.avgDaily(tid);
        if (!a) return 'Parado';
        if (a > 50) return 'Alto';
        if (a > 20) return 'Medio';
        if (a > 5) return 'Lento';
        return 'Baixo';
    },

    totalStock() {
        let t = 0;
        threads.forEach(th => { const l = this.latest(th.id); if (l) t += l.stockKg; });
        return t;
    },

    todayCons() {
        const t = today();
        const ps = subtractDay(t);
        let tot = 0;
        threads.forEach(th => {
            const a = counts.find(c => c.threadId === th.id && c.date === t);
            const b = counts.find(c => c.threadId === th.id && c.date === ps);
            if (a && b) { const d = b.stockKg - a.stockKg; if (d > 0) tot += d; }
        });
        return tot;
    },

    alerts() {
        const a = [];
        threads.forEach(t => {
            const st = this.status(t.id), d = this.daysLeft(t.id);
            if (st === 'critical')
                a.push({ type: 'red', icon: 'fa-circle-exclamation', title: 'Critico: ' + t.name, desc: `Estoque para ${d} dia(s). Compra urgente!` });
            else if (st === 'low')
                a.push({ type: 'amber', icon: 'fa-triangle-exclamation', title: 'Baixo: ' + t.name, desc: `Estoque para ${d} dias. Verificar reposicao.` });
            else if (st === 'stopped')
                a.push({ type: 'gray', icon: 'fa-pause-circle', title: 'Parado: ' + t.name, desc: 'Sem consumo detectado nos ultimos 3 dias.' });
        });
        return a;
    },

    dailyN(n) {
        return lastNDays(n).map(day => {
            const ps = subtractDay(day);
            let tot = 0;
            threads.forEach(t => {
                const a = counts.find(c => c.threadId === t.id && c.date === day);
                const b = counts.find(c => c.threadId === t.id && c.date === ps);
                if (a && b) { const d = b.stockKg - a.stockKg; if (d > 0) tot += d; }
            });
            return { date: day, v: tot };
        });
    },
    daily7() { return this.dailyN(7); },

    allCountDates() {
        const s = new Set();
        counts.forEach(c => { if (c.date) s.add(c.date); });
        return s;
    },

    countsForDay(dateStr) {
        const d = toYMD(dateStr) || dateStr;
        return counts.filter(c => c.date === d);
    },

    aiSummary() {
        if (!threads.length) return 'Nenhum fio cadastrado. Acesse Estoque para comecar.';
        if (!counts.length) return 'Realize a primeira contagem para ativar a analise.';
        const tot = this.totalStock();
        const crit = threads.filter(t => this.status(t.id) === 'critical').length;
        const low = threads.filter(t => this.status(t.id) === 'low').length;
        const stop = threads.filter(t => this.status(t.id) === 'stopped').length;
        const tc = this.todayCons();
        let s = `Estoque monitorado: ${fmtKg(tot)}. `;
        if (crit) s += `${crit} fio(s) em nivel critico — reposicao imediata. `;
        if (low) s += `${low} fio(s) com estoque baixo. `;
        if (stop) s += `${stop} fio(s) sem consumo detectado. `;
        if (tc > 0) s += `Consumo detectado hoje: ${fmtKg(tc)}. `;
        const wt = threads.filter(t => this.daysLeft(t.id));
        if (wt.length) {
            const avg = wt.reduce((a, t) => a + (this.daysLeft(t.id) || 0), 0) / wt.length;
            s += `Duracao media estimada: ${Math.round(avg)} dias.`;
        }
        return s;
    }
};

/* ── DAY STATUS ── */
const isClosed = d => !!(daysMeta[d] && daysMeta[d].closed);

function isNewDayAfterClose() {
    const t = today(), ps = subtractDay(t);
    return isClosed(ps) && !isClosed(t);
}

function updateDayPill() {
    const closed = isClosed(today());
    const pill = document.getElementById('day-pill');
    const txt = document.getElementById('day-pill-txt');
    if (pill) pill.className = 'topbar-day-pill ' + (closed ? 'closed' : 'open');
    if (txt) txt.textContent = closed ? 'Fechado' : 'Aberto';
    const btn = document.getElementById('close-day-btn');
    if (btn) {
        btn.className = 'close-day-btn ' + (closed ? 'closed-state' : 'open-state');
        btn.innerHTML = closed
            ? '<i class="fa fa-lock"></i> Dia Fechado'
            : '<i class="fa fa-lock"></i> Fechar o Dia de Hoje';
        btn.onclick = closed ? null : openCloseDaySheet;
    }
    const wrap = document.getElementById('count-day-pill-wrap');
    if (wrap) wrap.innerHTML = closed
        ? '<span class="badge badge-green"><i class="fa fa-lock"></i> Dia Fechado</span>'
        : '<span class="badge badge-amber"><i class="fa fa-circle pulse" style="font-size:6px"></i> Dia Aberto</span>';
}

function openCloseDaySheet() {
    const t = today();
    document.getElementById('cd-date-lbl').textContent = 'Data: ' + fmtDate(t);
    const dc = IIE.countsForDay(t);
    let tot = 0; dc.forEach(c => tot += c.stockKg);
    const sumEl = document.getElementById('cd-summary');
    if (!dc.length) {
        sumEl.innerHTML = '<div class="alert-item alert-amber"><i class="fa fa-triangle-exclamation alert-icon"></i><div class="alert-title">Nenhuma contagem registrada hoje</div></div>';
    } else {
        sumEl.innerHTML = `<div class="card" style="border-color:var(--blue-border)"><div class="card-body" style="padding:10px"><div class="info-row"><span class="info-label">Fios contados</span><span class="info-value">${dc.length}</span></div><div class="info-row" style="border:none"><span class="info-label">Estoque total</span><span class="info-value">${fmtKg(tot)}</span></div></div></div>`;
    }
    openSheet('sh-closeday');
}

async function confirmCloseDay() {
    const t = today();
    const rec = { date: t, closed: true, closedAt: new Date().toISOString() };
    await dbPut('days', rec);
    daysMeta[t] = rec;
    closeSheet(); updateDayPill();
    toast('Dia fechado com sucesso');
    if (activePage === 'count') renderCountPage();
}

/* ── DASHBOARD ── */
function renderDash() {
    const now = new Date();
    const el = document.getElementById('dash-greeting');
    if (el) el.textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    updateTopbarDate();
    updateDayPill();

    const tot = IIE.totalStock(), tc = IIE.todayCons();
    const crit = threads.filter(t => IIE.status(t.id) === 'critical').length;
    const stop = threads.filter(t => IIE.status(t.id) === 'stopped').length;

    document.getElementById('k-total').textContent = tot > 0 ? fmtN(tot) : '--';
    document.getElementById('k-cons').textContent = tc > 0 ? fmtN(tc) : '--';
    document.getElementById('k-crit').textContent = crit;
    document.getElementById('k-stop').textContent = stop;

    const critBadge = document.getElementById('crit-badge');
    if (critBadge) {
        critBadge.textContent = crit;
        critBadge.style.display = crit > 0 ? 'inline-block' : 'none';
    }
    const alertBadge = document.getElementById('alert-count-badge');
    if (alertBadge) alertBadge.textContent = IIE.alerts().length;

    renderDashAlerts(IIE.alerts());
    renderConsChart();
    renderTopThreads();

    const aiEl = document.getElementById('ai-summary-dash');
    if (aiEl) aiEl.textContent = IIE.aiSummary();
}

function renderDashAlerts(alerts) {
    const el = document.getElementById('dash-alerts');
    if (!el) return;
    if (!alerts || !alerts.length) {
        el.innerHTML = '<div class="alert-item alert-green"><i class="fa fa-check-circle alert-icon"></i><div><div class="alert-title">Sem alertas</div><div class="alert-desc">Todos os fios em situacao normal</div></div></div>';
        return;
    }
    const typeMap = { red: 'alert-red', amber: 'alert-amber', blue: 'alert-blue', green: 'alert-green', gray: 'alert-gray' };
    el.innerHTML = alerts.map(a =>
        `<div class="alert-item ${typeMap[a.type] || 'alert-gray'}"><i class="fa ${a.icon} alert-icon"></i><div><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div></div></div>`
    ).join('');
}

function renderConsChart() {
    const data = IIE.daily7();
    const canvas = document.getElementById('ch-cons');
    if (!canvas) return;
    if (consChartIns) { consChartIns.destroy(); consChartIns = null; }
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 160);
    g.addColorStop(0, 'rgba(59,130,246,0.25)');
    g.addColorStop(1, 'rgba(59,130,246,0)');
    consChartIns = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => { const [, m, dy] = d.date.split('-'); return `${dy}/${m}`; }),
            datasets: [{ data: data.map(d => d.v), borderColor: '#3b82f6', backgroundColor: g, borderWidth: 2, fill: true, tension: .4, pointBackgroundColor: '#3b82f6', pointRadius: 3, pointHoverRadius: 5 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: '#1a2235', borderColor: 'rgba(59,130,246,0.3)', borderWidth: 1, titleColor: '#94a3b8', bodyColor: '#f1f5f9', callbacks: { label: c => ' ' + fmtKg(c.raw) } }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#475569', font: { size: 9 } } },
                y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#475569', font: { size: 9 }, callback: v => v.toFixed(0) + 'kg' }, beginAtZero: true }
            }
        }
    });
}

function renderTopThreads() {
    const el = document.getElementById('top-threads');
    if (!el) return;
    const ranked = threads
        .map(t => ({ ...t, avg: IIE.avgDaily(t.id) || 0, status: IIE.status(t.id), lat: IIE.latest(t.id) }))
        .filter(t => t.avg > 0)
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 5);
    if (!ranked.length) {
        el.innerHTML = '<div class="empty-state" style="padding:16px"><i class="fa fa-database"></i><p>Realize contagens para ver ranking</p></div>';
        return;
    }
    el.innerHTML = ranked.map(t =>
        `<div class="thread-item status-${t.status}" onclick="openDetail('${t.id}')"><div class="thread-avatar"><i class="fa fa-wave-square"></i></div><div class="thread-info"><div class="thread-name">${t.name}</div><div class="thread-meta">${fmtKg(t.avg)}/dia consumo</div></div><div class="thread-right"><div class="thread-stock">${t.lat ? fmtN(t.lat.stockKg) : '--'}</div><div class="thread-days">kg</div></div></div>`
    ).join('');
}

/* ── ESTOQUE ── */
function renderStock() {
    const q = (document.getElementById('st-srch')?.value || '').toLowerCase();
    let list = threads.filter(t => t.name.toLowerCase().includes(q));
    if (curFilter !== 'all') list = list.filter(t => IIE.status(t.id) === curFilter);
    const sub = document.getElementById('stock-sub');
    if (sub) sub.textContent = `${threads.length} fio(s) cadastrado(s)`;
    const el = document.getElementById('st-list');
    if (!el) return;
    if (!threads.length) { el.innerHTML = '<div class="empty-state"><i class="fa fa-plus-circle"></i><h3>Nenhum Fio</h3><p>Clique em "Novo Fio" para comecar.</p></div>'; return; }
    if (!list.length) { el.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa fa-search"></i><p>Nenhum resultado encontrado</p></div>'; return; }
    const stL = { normal: 'Normal', low: 'Baixo', critical: 'Critico', stopped: 'Parado', 'no-data': 'Sem dados' };
    const stC = { normal: 'badge-blue', low: 'badge-amber', critical: 'badge-red', stopped: 'badge-gray', 'no-data': 'badge-gray' };
    el.innerHTML = list.map(t => {
        const st = IIE.status(t.id), lat = IIE.latest(t.id), d = IIE.daysLeft(t.id);
        return `<div class="thread-item status-${t.status || st}" onclick="openDetail('${t.id}')"><div class="thread-avatar"><i class="fa fa-wave-square"></i></div><div class="thread-info"><div class="thread-name">${t.name}</div><div class="thread-meta">${t.weightPerBox} kg/cx &bull; ${t.boxesPerHeight} cx/alt</div></div><div class="thread-right"><div class="thread-stock">${lat ? fmtN(lat.stockKg) : '--'}</div><div class="thread-days">${d !== null ? d + ' dias' : 'sem previsao'}</div><div style="margin-top:3px"><span class="badge ${stC[st]}">${stL[st]}</span></div></div></div>`;
    }).join('');
}

function setFilter(f, el) {
    curFilter = f;
    document.querySelectorAll('#st-chips .chip').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    renderStock();
}

/* ── ADD / EDIT THREAD ── */
function openAddThread() {
    editingThread = null;
    document.getElementById('sh-thread-title').textContent = 'Cadastrar Fio';
    document.getElementById('sh-thread-save-btn').innerHTML = '<i class="fa fa-plus"></i> Cadastrar';
    document.getElementById('sh-thread-del-btn').style.display = 'none';
    document.getElementById('edit-recalc-warn').style.display = 'none';
    ['inp-name', 'inp-wpb', 'inp-bph'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('thread-preview').style.display = 'none';
    openSheet('sh-thread');
    setTimeout(() => document.getElementById('inp-name').focus(), 350);
}

function editCurrentThread() {
    if (!activeThread) return;
    editingThread = activeThread;
    document.getElementById('sh-thread-title').textContent = 'Editar Fio';
    document.getElementById('sh-thread-save-btn').innerHTML = '<i class="fa fa-check"></i> Salvar Alteracoes';
    document.getElementById('sh-thread-del-btn').style.display = 'flex';
    document.getElementById('edit-recalc-warn').style.display = 'block';
    document.getElementById('inp-name').value = editingThread.name;
    document.getElementById('inp-wpb').value = editingThread.weightPerBox;
    document.getElementById('inp-bph').value = editingThread.boxesPerHeight;
    closeSheet();
    setTimeout(() => { openSheet('sh-thread'); updatePreview(); }, 100);
}

function updatePreview() {
    const w = parseFloat(document.getElementById('inp-wpb').value);
    const b = parseInt(document.getElementById('inp-bph').value);
    const box = document.getElementById('thread-preview');
    if (w > 0 && b > 0) {
        box.style.display = 'block';
        document.getElementById('prev-1h').textContent = `${b} cx = ${fmtKg(b * w)}`;
        document.getElementById('prev-pal').textContent = fmtKg(10 * b * w);
    } else { box.style.display = 'none'; }
}

async function saveThread() {
    const name = document.getElementById('inp-name').value.trim();
    const w = parseFloat(document.getElementById('inp-wpb').value);
    const b = parseInt(document.getElementById('inp-bph').value);
    if (!name) { toast('Informe o nome do fio', 'err'); return; }
    if (!w || w <= 0) { toast('Informe o peso por caixa', 'err'); return; }
    if (!b || b <= 0) { toast('Informe as caixas por altura', 'err'); return; }
    if (editingThread) {
        const changed = Math.abs(editingThread.weightPerBox - w) > 0.001 || editingThread.boxesPerHeight !== b;
        Object.assign(editingThread, { name, weightPerBox: w, boxesPerHeight: b, updatedAt: new Date().toISOString() });
        await dbPut('threads', editingThread);
        const i = threads.findIndex(t => t.id === editingThread.id);
        if (i >= 0) threads[i] = editingThread;
        if (changed) {
            const tc = counts.filter(c => c.threadId === editingThread.id);
            for (const c of tc) { c.stockKg = c.totalBoxes * w; await dbPut('counts', c); }
            toast(`${name} atualizado — ${tc.length} contagens recalculadas`);
        } else { toast(name + ' atualizado'); }
        editingThread = null;
    } else {
        const t = { id: uid(), name, weightPerBox: w, boxesPerHeight: b, createdAt: new Date().toISOString() };
        await dbPut('threads', t);
        threads.push(t);
        toast(name + ' cadastrado');
    }
    closeSheet(); renderStock(); renderDash();
}

async function deleteThread() {
    if (!editingThread) return;
    if (!confirm('Excluir "' + editingThread.name + '" e todo seu historico?')) return;
    await dbDel('threads', editingThread.id);
    const tc = counts.filter(c => c.threadId === editingThread.id);
    for (const c of tc) await dbDel('counts', c.id);
    threads = threads.filter(t => t.id !== editingThread.id);
    counts = counts.filter(c => c.threadId !== editingThread.id);
    editingThread = null; activeThread = null;
    closeSheet(); renderStock(); renderDash(); toast('Fio removido');
}

/* ── THREAD DETAIL ── */
async function openDetail(tid) {
    const t = threads.find(x => x.id === tid);
    if (!t) return;
    activeThread = t;
    const st = IIE.status(t.id), lat = IIE.latest(t.id), d = IIE.daysLeft(t.id), avg = IIE.avgDaily(t.id);
    document.getElementById('det-name').textContent = t.name;
    document.getElementById('det-meta').textContent = `${t.weightPerBox} kg/cx | ${t.boxesPerHeight} cx/alt`;
    document.getElementById('det-stock').textContent = lat ? fmtN(lat.stockKg) : '--';
    document.getElementById('det-days').textContent = d !== null ? String(d) : '--';
    document.getElementById('det-avg').textContent = avg ? fmtKg(avg) : 'Sem dados';
    document.getElementById('det-wkly').textContent = avg ? fmtKg(avg * 7) : 'Sem dados';
    document.getElementById('det-cls').textContent = IIE.cls(t.id);
    const bC = { normal: 'badge-blue', low: 'badge-amber', critical: 'badge-red', stopped: 'badge-gray', 'no-data': 'badge-gray' };
    const bL = { normal: 'Normal', low: 'Baixo', critical: 'Critico', stopped: 'Parado', 'no-data': 'Sem dados' };
    document.getElementById('det-badge').innerHTML = `<span class="badge ${bC[st]}">${bL[st]}</span>`;
    const tc = IIE.tc(t.id).slice(-10);
    const dc = document.getElementById('det-chart');
    if (detChartIns) { detChartIns.destroy(); detChartIns = null; }
    if (tc.length > 1 && dc) {
        const ctx = dc.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, 120);
        g.addColorStop(0, 'rgba(59,130,246,0.2)');
        g.addColorStop(1, 'rgba(59,130,246,0)');
        detChartIns = new Chart(ctx, {
            type: 'line',
            data: {
                labels: tc.map(c => fmtDate(c.date)),
                datasets: [{ data: tc.map(c => c.stockKg), borderColor: '#3b82f6', backgroundColor: g, borderWidth: 2, fill: true, tension: .4, pointRadius: 2, pointBackgroundColor: '#3b82f6' }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 8 }, maxTicksLimit: 5 } },
                    y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#475569', font: { size: 8 }, callback: v => v + 'kg' }, beginAtZero: true }
                }
            }
        });
    }
    openSheet('sh-detail');
}

/* ── CONTAGEM ── */
function renderCountPage() {
    const now = new Date();
    const el = document.getElementById('count-date-sub');
    if (el) el.textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    updateDayPill();
    filterCountList();
    const sel = document.getElementById('mix-thread');
    if (sel) {
        const prev = sel.value;
        sel.innerHTML = '<option value="">Selecione o fio...</option>' + threads.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        if (prev) sel.value = prev;
    }
}

function filterCountList() {
    const q = (document.getElementById('cnt-srch')?.value || '').toLowerCase();
    const list = threads.filter(t => t.name.toLowerCase().includes(q));
    const el = document.getElementById('cnt-list');
    if (!el) return;
    if (!threads.length) { el.innerHTML = '<div class="empty-state"><i class="fa fa-plus-circle"></i><h3>Nenhum Fio</h3><p>Cadastre fios em Estoque primeiro.</p></div>'; return; }
    if (!list.length) { el.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa fa-search"></i><p>Nenhum resultado</p></div>'; return; }
    const t = today();
    el.innerHTML = list.map(th => {
        const st = IIE.status(th.id), lat = IIE.latest(th.id);
        const ex = counts.find(c => c.threadId === th.id && c.date === t);
        const isNewDay = isNewDayAfterClose();
        const show = ex && !isNewDay;
        return `<div class="thread-item status-${st}" onclick="selectThread('${th.id}')"><div class="thread-avatar"><i class="fa fa-wave-square"></i></div><div class="thread-info"><div class="thread-name">${th.name}</div><div class="thread-meta">${th.weightPerBox} kg/cx${show ? ` &bull; <span style="color:var(--green)">Hoje: ${fmtKg(ex.stockKg)}</span>` : ''}</div></div><div class="thread-right"><div class="thread-stock">${lat ? fmtN(lat.stockKg) : '--'}</div><div class="thread-days">kg atual</div>${show ? '<div style="margin-top:2px"><span class="badge badge-green"><i class="fa fa-check"></i></span></div>' : ''}</div></div>`;
    }).join('');
}

function selectThread(tid) {
    const t = threads.find(x => x.id === tid);
    if (!t) return;
    activeThread = t;
    const isNewDay = isNewDayAfterClose();
    cntH = 0; cntL = 0; cntProd = 0; cntStack = [];
    if (!isNewDay) {
        const ex = counts.find(c => c.threadId === tid && c.date === today());
        if (ex) { cntH = ex.heights || 0; cntL = ex.looseBoxes || 0; cntProd = ex.production || 0; }
    }
    document.getElementById('cnt-selector').style.display = 'none';
    document.getElementById('cnt-iface').style.display = 'block';
    document.getElementById('cnt-thread-name').textContent = t.name;
    document.getElementById('cnt-thread-meta').textContent = `${t.weightPerBox} kg/cx • ${t.boxesPerHeight} cx/alt`;
    document.getElementById('cs-bph').textContent = t.boxesPerHeight;
    const todayBadge = document.getElementById('cnt-today-badge');
    const ex = counts.find(c => c.threadId === tid && c.date === today());
    if (todayBadge) todayBadge.innerHTML = (ex && !isNewDay) ? '<span class="badge badge-green"><i class="fa fa-edit"></i> Editando</span>' : '';
    const sel = document.getElementById('mix-thread');
    if (sel) sel.innerHTML = '<option value="">Selecione o fio...</option>' + threads.filter(x => x.id !== tid).map(x => `<option value="${x.id}">${x.name}</option>`).join('');
    updateCountDisplay(); updateDayPill();
}

function startCountForThread() { if (activeThread) selectThread(activeThread.id); }

const addH = n => { cntStack.push({ t: 'h', n }); cntH += n; updateCountDisplay(); vib(); };
const addL = n => { cntStack.push({ t: 'l', n }); cntL += n; updateCountDisplay(); vib(); };

function addProd() {
    const n = parseInt(document.getElementById('prod-inp').value) || 0;
    if (n <= 0) { toast('Informe a quantidade', 'err'); return; }
    cntStack.push({ t: 'p', n }); cntProd += n;
    document.getElementById('prod-inp').value = '';
    updateCountDisplay(); toast(`+${n} caixas de entrada`, 'info'); vib();
}

function updateMixedPreview() {
    const qty = parseInt(document.getElementById('mix-qty').value) || 0;
    const tid = document.getElementById('mix-thread').value;
    const pct = Math.min(99, Math.max(1, parseInt(document.getElementById('mix-pct').value) || 50));
    document.getElementById('mix-pct').value = pct;
    document.getElementById('mix-pct2').value = 100 - pct;
    const prev = document.getElementById('mix-preview');
    if (!qty || !tid || !activeThread) { prev.style.display = 'none'; return; }
    const otherT = threads.find(t => t.id === tid);
    if (!otherT) { prev.style.display = 'none'; return; }
    const myKg = qty * activeThread.weightPerBox * (pct / 100);
    const otherKg = qty * otherT.weightPerBox * ((100 - pct) / 100);
    prev.style.display = 'block';
    prev.innerHTML = `<strong>${activeThread.name}:</strong> +${myKg.toFixed(1)} kg (${pct}%)<br><strong>${otherT.name}:</strong> +${otherKg.toFixed(1)} kg (${100 - pct}%)<br><span style="color:var(--t3)">Total de ${qty} caixas divididas</span>`;
}

async function applyMixed() {
    const qty = parseInt(document.getElementById('mix-qty').value) || 0;
    const tid = document.getElementById('mix-thread').value;
    const pct = Math.min(99, Math.max(1, parseInt(document.getElementById('mix-pct').value) || 50));
    if (!qty || qty <= 0) { toast('Informe a quantidade de caixas', 'err'); return; }
    if (!tid) { toast('Selecione o outro fio', 'err'); return; }
    if (!activeThread) return;
    const otherT = threads.find(t => t.id === tid);
    if (!otherT) { toast('Fio nao encontrado', 'err'); return; }
    if (isClosed(today())) { toast('Dia ja fechado', 'err'); return; }
    const myBoxes = Math.round(qty * (pct / 100));
    const otherBoxes = qty - myBoxes;
    cntStack.push({ t: 'l', n: myBoxes }); cntL += myBoxes;
    updateCountDisplay();
    const t2 = today();
    const ex2 = counts.find(c => c.threadId === tid && c.date === t2);
    const pH = ex2 ? ex2.heights || 0 : 0;
    const pL = ex2 ? ex2.looseBoxes || 0 : 0;
    const pP = ex2 ? ex2.production || 0 : 0;
    const tot2 = (pH * otherT.boxesPerHeight) + pL + otherBoxes + pP;
    const kg2 = tot2 * otherT.weightPerBox;
    const rec2 = { threadId: tid, date: t2, heights: pH, looseBoxes: pL + otherBoxes, production: pP, totalBoxes: tot2, stockKg: kg2, timestamp: new Date().toISOString() };
    if (ex2) { rec2.id = ex2.id; await dbPut('counts', rec2); counts[counts.findIndex(c => c.id === ex2.id)] = rec2; }
    else { const id = await dbPut('counts', rec2); rec2.id = id; counts.push(rec2); }
    document.getElementById('mix-qty').value = '';
    document.getElementById('mix-thread').value = '';
    document.getElementById('mix-preview').style.display = 'none';
    toast(`${myBoxes} cx adicionadas aqui, ${otherBoxes} cx em ${otherT.name}`, 'info');
    vib([20, 10, 40]);
}

function undoAction() {
    if (!cntStack.length) return;
    const last = cntStack.pop();
    if (last.t === 'h') cntH = Math.max(0, cntH - last.n);
    if (last.t === 'l') cntL = Math.max(0, cntL - last.n);
    if (last.t === 'p') cntProd = Math.max(0, cntProd - last.n);
    updateCountDisplay();
}

function resetCount() {
    if (confirm('Zerar contagem atual?')) { cntH = 0; cntL = 0; cntProd = 0; cntStack = []; updateCountDisplay(); }
}

function updateCountDisplay() {
    if (!activeThread) return;
    const boxes = (cntH * activeThread.boxesPerHeight) + cntL + cntProd;
    const kg = boxes * activeThread.weightPerBox;
    document.getElementById('cnt-num').textContent = boxes;
    document.getElementById('cnt-kg').textContent = fmtKg(kg);
    document.getElementById('cs-alt').textContent = cntH;
    document.getElementById('cs-avul').textContent = cntL;
    document.getElementById('cs-prod').textContent = cntProd;
    const metaAlt = document.getElementById('sec-alturas-meta');
    if (metaAlt) metaAlt.textContent = cntH > 0 ? `${cntH} alturas = ${cntH * activeThread.boxesPerHeight} caixas` : 'Toque para expandir';
}

async function saveCount() {
    if (!activeThread) return;
    if (isClosed(today())) { toast('Dia ja fechado — edicao bloqueada', 'err'); return; }
    const boxes = (cntH * activeThread.boxesPerHeight) + cntL + cntProd;
    const kg = boxes * activeThread.weightPerBox;
    const t = today();
    const ex = counts.find(c => c.threadId === activeThread.id && c.date === t);
    const rec = { threadId: activeThread.id, date: t, heights: cntH, looseBoxes: cntL, production: cntProd, totalBoxes: boxes, stockKg: kg, timestamp: new Date().toISOString() };
    if (ex) { rec.id = ex.id; await dbPut('counts', rec); counts[counts.findIndex(c => c.id === ex.id)] = rec; }
    else { const id = await dbPut('counts', rec); rec.id = id; counts.push(rec); }
    vib([30, 15, 60]);
    toast(`Salvo: ${boxes} cx — ${fmtKg(kg)}`);
    clearCntIface(); renderDash();
}

function clearCntIface() {
    activeThread = null; cntH = 0; cntL = 0; cntProd = 0; cntStack = [];
    document.getElementById('cnt-selector').style.display = 'block';
    document.getElementById('cnt-iface').style.display = 'none';
    renderCountPage();
}

/* ══════════════════════════════════════════════════════════════
   CALENDÁRIO
   - Sempre inicializa no mês ATUAL (hoje), não no seed histórico
   - O usuário pode navegar livremente para meses passados
   - allCountDates() garante datas normalizadas no Set
   - openCalDay() normaliza a data antes de qualquer operação
══════════════════════════════════════════════════════════════ */

function renderCal() {
    const now = new Date();
    // CORREÇÃO: sempre inicia no mês real de hoje se ainda não navegou
    if (calYear === undefined || calYear === null) {
        calYear = now.getFullYear();
        calMonth = now.getMonth();
    }
    const dsEl = document.getElementById('date-search');
    if (dsEl) dsEl.value = '';

    const mv = document.getElementById('cal-month-view');
    const wv = document.getElementById('cal-week-view');
    if (mv) mv.style.display = calView === 'month' ? 'block' : 'none';
    if (wv) wv.style.display = calView === 'week' ? 'block' : 'none';

    if (calView === 'month') renderMonthView();
    else renderWeekView();
    renderCalHist();
}

function setCalView(v, el) {
    calView = v;
    document.querySelectorAll('.cal-vbtn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    const mv = document.getElementById('cal-month-view');
    const wv = document.getElementById('cal-week-view');
    if (mv) mv.style.display = v === 'month' ? 'block' : 'none';
    if (wv) wv.style.display = v === 'week' ? 'block' : 'none';
    if (v === 'month') renderMonthView(); else renderWeekView();
}

function renderMonthView() {
    const mN = ['Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const titleEl = document.getElementById('cal-month-title');
    if (titleEl) titleEl.textContent = mN[calMonth] + ' ' + calYear;

    const grid = document.getElementById('cal-grid');
    if (!grid) return;

    while (grid.children.length > 7) grid.removeChild(grid.lastChild);

    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const daysInM = new Date(calYear, calMonth + 1, 0).getDate();
    const todayStr = today();

    const dwd = IIE.allCountDates();

    for (let i = 0; i < firstDow; i++) {
        const e = document.createElement('div');
        e.className = 'cal-day empty';
        grid.appendChild(e);
    }

    for (let d = 1; d <= daysInM; d++) {
        const ds = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const el = document.createElement('div');
        el.className = 'cal-day';
        if (ds === todayStr) el.classList.add('today');
        if (dwd.has(ds)) el.classList.add('has-data');
        if (daysMeta[ds] && daysMeta[ds].closed) el.classList.add('closed-day');
        el.innerHTML = `<span class="cal-day-num">${d}</span><span class="cal-day-dot"></span>`;
        el.onclick = () => openCalDay(ds);
        grid.appendChild(el);
    }
}

function renderWeekView() {
    const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    const mN = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const titleEl = document.getElementById('cal-month-title');
    if (titleEl) titleEl.textContent = mN[calMonth] + ' ' + calYear;

    const grid = document.getElementById('week-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const todayStr = today();
    const dwd = IIE.allCountDates();

    const refDate = new Date(calYear, calMonth, 1);
    const dow = refDate.getDay();
    const wkStart = new Date(calYear, calMonth, 1 - dow);

    for (let i = 0; i < 7; i++) {
        const d = new Date(wkStart.getFullYear(), wkStart.getMonth(), wkStart.getDate() + i);
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dc = IIE.countsForDay(ds);
        const el = document.createElement('div');
        el.className = 'week-day';
        if (ds === todayStr) el.classList.add('today');
        if (dwd.has(ds)) el.classList.add('has-data');
        el.innerHTML = `<div class="week-day-name">${dn[i]}</div><div class="week-day-num">${d.getDate()}</div><div class="week-day-entries">${dc.length ? dc.length + ' reg' : ''}</div>`;
        el.onclick = () => openCalDay(ds);
        grid.appendChild(el);
    }
}

function jumpToDate() {
    const v = document.getElementById('date-search')?.value;
    if (!v) return;
    const [y, m] = v.split('-').map(Number);
    calYear = y;
    calMonth = m - 1;
    if (calView === 'month') renderMonthView(); else renderWeekView();
}

const prevM = () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    if (calView === 'month') renderMonthView(); else renderWeekView();
};
const nextM = () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    if (calView === 'month') renderMonthView(); else renderWeekView();
};

function openCalDay(ds) {
    const nd = toYMD(ds) || ds;
    const [y, m, d] = nd.split('-');
    document.getElementById('calday-title').textContent = `${d}/${m}/${y}`;
    const closed = isClosed(nd);
    document.getElementById('calday-status').innerHTML = closed
        ? '<span class="badge badge-green"><i class="fa fa-lock"></i> Dia Fechado</span>'
        : '<span class="badge badge-amber">Em aberto</span>';

    const body = document.getElementById('calday-body');
    const dc = IIE.countsForDay(nd);

    let html = '';
    if (dc.length) {
        let tot = 0; dc.forEach(c => tot += c.stockKg);
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <span style="font-size:11px;color:var(--t2)">Total: <strong style="color:var(--t1);font-family:var(--mono)">${fmtKg(tot)}</strong></span>
                    <span class="badge badge-blue">${dc.length} fios</span>
                 </div>`;
        html += dc.map(c => {
            const t = threads.find(x => x.id === c.threadId);
            if (!t) return '';
            const prevDs = subtractDay(nd);
            const prev = counts.find(x => x.threadId === c.threadId && x.date === prevDs);
            const diff = prev ? c.stockKg - prev.stockKg : null;
            const diffHtml = diff !== null
                ? diff < 0
                    ? `<span style="color:var(--red);font-family:var(--mono);font-size:11px">▼ ${fmtKg(Math.abs(diff))}</span>`
                    : diff > 0.1
                        ? `<span style="color:var(--green);font-family:var(--mono);font-size:11px">▲ +${fmtKg(diff)}</span>`
                        : ''
                : '';
            return `<div class="history-entry">
                        <div class="h-top"><div class="h-name">${t.name}</div>${diffHtml}</div>
                        <div class="h-details">
                            <div class="h-detail">Cx: <span>${c.totalBoxes}</span></div>
                            <div class="h-detail">Estoque: <span>${fmtKg(c.stockKg)}</span></div>
                            <div class="h-detail">Alt: <span>${c.heights}</span></div>
                            ${c.production ? `<div class="h-detail">Prod+: <span>${c.production}</span></div>` : ''}
                        </div>
                    </div>`;
        }).join('');
    } else {
        html = '<div class="empty-state" style="padding:16px"><i class="fa fa-calendar-xmark"></i><p>Nenhuma contagem neste dia</p></div>';
    }

    html += `<div class="divider"></div><div class="section-label">Editar / Adicionar Contagem</div>`;
    if (!closed) {
        html += threads.map(t => {
            const ex = counts.find(c => c.threadId === t.id && c.date === nd);
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r-sm)">
                        <div style="flex:1;min-width:0">
                            <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name}</div>
                            <div style="font-size:10px;color:var(--t3)">${ex ? 'Atual: ' + fmtKg(ex.stockKg) : 'Sem contagem'}</div>
                        </div>
                        <input type="number" placeholder="kg total" value="${ex ? ex.stockKg : ''}" id="cedt-${t.id}"
                            style="width:70px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:7px 8px;color:var(--t1);font-size:12px;font-family:var(--mono);outline:none"
                            onfocus="this.style.borderColor='var(--blue-border)'" onblur="this.style.borderColor='var(--border)'">
                        <button onclick="saveCalEdit('${t.id}','${nd}')"
                            style="background:var(--blue-dim);border:1px solid var(--blue-border);border-radius:6px;color:var(--blue);font-size:11px;font-weight:700;padding:7px 10px;cursor:pointer;white-space:nowrap;font-family:var(--font)">OK</button>
                    </div>`;
        }).join('');
    } else {
        html += `<div class="alert-item alert-gray"><i class="fa fa-lock alert-icon"></i><div class="alert-title">Dia fechado — edicao bloqueada</div></div>`;
    }

    body.innerHTML = html;
    openSheet('sh-calday');
}

async function saveCalEdit(tid, ds) {
    const nd = toYMD(ds) || ds;
    if (isClosed(nd)) { toast('Dia fechado', 'err'); return; }
    const inp = document.getElementById('cedt-' + tid);
    if (!inp) return;
    const kg = parseFloat(inp.value);
    if (isNaN(kg) || kg < 0) { toast('Valor invalido', 'err'); return; }
    const t = threads.find(x => x.id === tid);
    if (!t) return;
    const ex = counts.find(c => c.threadId === tid && c.date === nd);
    const boxes = Math.round(kg / t.weightPerBox);
    const rec = { threadId: tid, date: nd, heights: 0, looseBoxes: boxes, production: 0, totalBoxes: boxes, stockKg: kg, timestamp: new Date().toISOString(), manualEdit: true };
    if (ex) { rec.id = ex.id; await dbPut('counts', rec); counts[counts.findIndex(c => c.id === ex.id)] = rec; }
    else { const id = await dbPut('counts', rec); rec.id = id; counts.push(rec); }
    toast('Salvo: ' + fmtKg(kg));
    renderMonthView();
    renderCalHist();
    openCalDay(nd);
}

function renderCalHist() {
    const el = document.getElementById('cal-hist');
    if (!el) return;
    if (!counts.length) {
        el.innerHTML = '<div class="empty-state" style="padding:20px"><i class="fa fa-history"></i><p>Nenhuma contagem registrada</p></div>';
        return;
    }
    const sorted = [...counts]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 25);
    el.innerHTML = sorted.map(c => {
        const t = threads.find(x => x.id === c.threadId);
        if (!t) return '';
        const prevDs = subtractDay(c.date);
        const prev = counts.find(x => x.threadId === c.threadId && x.date === prevDs);
        const diff = prev ? c.stockKg - prev.stockKg : null;
        const diffLbl = diff !== null && Math.abs(diff) > 0.1
            ? `<div class="h-detail">${diff < 0 ? 'Consumo' : 'Entrada'}: <span style="color:${diff < 0 ? 'var(--red)' : 'var(--green)'}">${fmtKg(Math.abs(diff))}</span></div>`
            : '';
        return `<div class="history-entry">
                    <div class="h-top"><div class="h-name">${t.name}</div><div class="h-date">${fmtDate(c.date)}</div></div>
                    <div class="h-details">
                        <div class="h-detail">Estoque: <span>${fmtKg(c.stockKg)}</span></div>
                        <div class="h-detail">Cx: <span>${c.totalBoxes}</span></div>
                        ${diffLbl}
                    </div>
                </div>`;
    }).join('');
}

/* ── RELATORIOS ── */
function setPeriod(p, el) {
    repPeriod = p;
    document.querySelectorAll('#rep-tabs .tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
}

function renderReports() {
    const tot = IIE.totalStock();
    const d7 = IIE.daily7().reduce((a, b) => a + b.v, 0);
    const crit = threads.filter(t => IIE.status(t.id) === 'critical').length;
    const repStats = document.getElementById('rep-stats');
    if (repStats) repStats.innerHTML = `
        <div class="stat-box"><div class="stat-box-val" style="color:var(--blue)">${fmtN(tot)}</div><div class="stat-box-lbl">Total kg</div></div>
        <div class="stat-box"><div class="stat-box-val" style="color:var(--green)">${fmtN(d7)}</div><div class="stat-box-lbl">Consumo 7d</div></div>
        <div class="stat-box"><div class="stat-box-val" style="color:var(--red)">${crit}</div><div class="stat-box-lbl">Criticos</div></div>`;
    const repAi = document.getElementById('rep-ai');
    if (repAi) repAi.textContent = IIE.aiSummary();
    const stL = { normal: 'Normal', low: 'Baixo', critical: 'Critico', stopped: 'Parado', 'no-data': 'Sem dados' };
    const stColor = { normal: 'var(--blue)', low: 'var(--amber)', critical: 'var(--red)', stopped: 'var(--t3)', 'no-data': 'var(--t3)' };
    const tbody = document.getElementById('rep-table-body');
    const badge = document.getElementById('rep-total-badge');
    if (badge) badge.textContent = threads.length + ' fios';
    if (!threads.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:20px">Nenhum fio cadastrado</td></tr>';
        return;
    }
    if (tbody) tbody.innerHTML = threads.map(t => {
        const st = IIE.status(t.id), lat = IIE.latest(t.id), avg = IIE.avgDaily(t.id), d = IIE.daysLeft(t.id);
        const pct = d && d > 0 ? Math.min(100, Math.round(d / 30 * 100)) : 0;
        const bc = st === 'critical' ? 'var(--red)' : st === 'low' ? 'var(--amber)' : 'var(--green)';
        return `<tr>
            <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.name}</td>
            <td class="mono">${lat ? fmtKg(lat.stockKg) : '--'}</td>
            <td class="mono">${avg ? fmtKg(avg) : '--'}</td>
            <td class="mono">${avg ? fmtKg(avg * 7) : '--'}</td>
            <td><div style="font-family:var(--mono);font-size:11px;color:var(--t1)">${d !== null ? d + 'd' : '--'}</div>
                <div class="rep-bar"><div class="rep-bar-fill" style="width:${pct}%;background:${bc}"></div></div></td>
            <td><span style="font-size:10px;font-weight:700;color:${stColor[st]}">${stL[st]}</span></td>
        </tr>`;
    }).join('');
    const tl = document.getElementById('rep-thread-list');
    if (tl) tl.innerHTML = threads.map(t => {
        const st = IIE.status(t.id), lat = IIE.latest(t.id), avg = IIE.avgDaily(t.id), d = IIE.daysLeft(t.id);
        const pct = d && d > 0 ? Math.min(100, Math.round(d / 30 * 100)) : 0;
        const stC2 = { normal: 'badge-blue', low: 'badge-amber', critical: 'badge-red', stopped: 'badge-gray', 'no-data': 'badge-gray' };
        return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <div style="font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:6px">${t.name}</div>
                <span class="badge ${stC2[st]}" style="font-size:9px;flex-shrink:0">${stL[st]}</span>
            </div>
            <div style="display:flex;gap:10px;margin-bottom:5px;flex-wrap:wrap">
                <span style="font-size:10px;color:var(--t3)">Est: <strong style="color:var(--t1);font-family:var(--mono)">${lat ? fmtKg(lat.stockKg) : '--'}</strong></span>
                <span style="font-size:10px;color:var(--t3)">Cons: <strong style="color:var(--t1);font-family:var(--mono)">${avg ? fmtKg(avg) : '--'}</strong></span>
                <span style="font-size:10px;color:var(--t3)">Prev: <strong style="color:var(--t1);font-family:var(--mono)">${d !== null ? d + 'd' : '--'}</strong></span>
            </div>
            <div style="height:3px;border-radius:2px;background:var(--bg4);overflow:hidden">
                <div style="height:100%;border-radius:2px;width:${pct}%;background:${st === 'critical' ? 'var(--red)' : st === 'low' ? 'var(--amber)' : 'var(--green)'};transition:width .5s"></div>
            </div>
        </div>`;
    }).join('');
    renderRepChart();
}

function renderRepChart() {
    const data = IIE.daily7();
    const canvas = document.getElementById('ch-rep');
    if (!canvas) return;
    if (repChartIns) { repChartIns.destroy(); repChartIns = null; }
    const ctx = canvas.getContext('2d');
    repChartIns = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => { const [, m, dy] = d.date.split('-'); return `${dy}/${m}`; }),
            datasets: [{ data: data.map(d => d.v), backgroundColor: 'rgba(16,185,129,0.6)', borderColor: '#10b981', borderWidth: 1, borderRadius: 4 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a2235', callbacks: { label: c => ' ' + fmtKg(c.raw) } } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 9 } } },
                y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#475569', font: { size: 9 }, callback: v => v + 'kg' }, beginAtZero: true }
            }
        }
    });
}

/* ── PDF ── */
async function genReport(type) {
    toast('Gerando PDF...', 'info');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, now = new Date();
    const ds = now.toLocaleDateString('pt-BR'), ts = now.toLocaleTimeString('pt-BR');
    const pL = { day: 'Diario', week: 'Semanal', month: 'Mensal' };
    const tL = { full: 'Completo', consumption: 'Consumo', critical: 'Fios Criticos', forecast: 'Previsao de Estoque', movements: 'Movimentacoes' };
    doc.setFillColor(15, 23, 42); doc.rect(0, 0, W, 28, 'F');
    doc.setFillColor(59, 130, 246); doc.rect(0, 0, 5, 28, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text('Embalagens Tatui — Estoque de Fios', 10, 11);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(148, 163, 184);
    doc.text('Industrial Intelligence Engine — Relatorio Automatizado', 10, 17);
    doc.text(`Emitido: ${ds} ${ts}`, W - 8, 11, { align: 'right' });
    doc.text(`${pL[repPeriod]} | Tipo: ${tL[type]}`, W - 8, 17, { align: 'right' });
    doc.setFontSize(20); doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold');
    doc.text(`Relatorio ${tL[type]}`, 10, 38);
    doc.setFontSize(9); doc.setTextColor(100, 116, 139); doc.setFont('helvetica', 'normal');
    doc.text(`Periodo: ${pL[repPeriod]} | ${threads.length} fios monitorados | ${counts.length} contagens`, 10, 44);
    doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.4); doc.line(10, 47, W - 10, 47);
    const tot = IIE.totalStock(), tc = IIE.todayCons();
    const crit = threads.filter(t => IIE.status(t.id) === 'critical').length;
    const stop = threads.filter(t => IIE.status(t.id) === 'stopped').length;
    const kpis = [
        { l: 'ESTOQUE TOTAL', v: fmtKg(tot), r: 59, g: 130, b2: 246 },
        { l: 'CONSUMO HOJE', v: fmtKg(tc), r: 16, g: 185, b2: 129 },
        { l: 'FIOS CRITICOS', v: String(crit), r: 239, g: 68, b2: 68 },
        { l: 'FIOS PARADOS', v: String(stop), r: 245, g: 158, b2: 11 }
    ];
    kpis.forEach((k, i) => {
        const x = 10 + (i % 2) * 100, y = 50 + Math.floor(i / 2) * 20;
        doc.setFillColor(248, 250, 252); doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.3);
        doc.roundedRect(x, y, 92, 16, 2, 2, 'FD');
        doc.setFillColor(k.r, k.g, k.b2); doc.rect(x, y, 3, 16, 'F');
        doc.setFontSize(7); doc.setTextColor(100, 116, 139); doc.setFont('helvetica', 'bold');
        doc.text(k.l, x + 6, y + 6);
        doc.setFontSize(11); doc.setTextColor(k.r, k.g, k.b2); doc.setFont('helvetica', 'bold');
        doc.text(k.v, x + 6, y + 13);
    });
    let y = 95;
    doc.setDrawColor(226, 232, 240); doc.line(10, y, W - 10, y);
    doc.setFillColor(30, 42, 64); doc.rect(10, y, W - 20, 9, 'F');
    doc.setFontSize(7.5); doc.setTextColor(148, 163, 184); doc.setFont('helvetica', 'bold');
    const cols = [{ l: 'FIO', x: 14 }, { l: 'ESTOQUE', x: 72 }, { l: 'CONS/DIA', x: 100 }, { l: '7 DIAS', x: 127 }, { l: 'PREVISAO', x: 152 }, { l: 'CX/ALT', x: 174 }, { l: 'STATUS', x: 192 }];
    cols.forEach(c => doc.text(c.l, c.x, y + 6));
    y += 9;
    threads.forEach((t, i) => {
        if (y > 272) { doc.addPage(); y = 20; }
        if (i % 2 === 0) { doc.setFillColor(250, 251, 254); doc.rect(10, y - 1, W - 20, 9, 'F'); }
        const lat = IIE.latest(t.id), avg = IIE.avgDaily(t.id), d = IIE.daysLeft(t.id), st = IIE.status(t.id);
        const stC = { normal: [59, 130, 246], low: [245, 158, 11], critical: [239, 68, 68], stopped: [100, 116, 139], 'no-data': [100, 116, 139] };
        const stN = { normal: 'NORMAL', low: 'BAIXO', critical: 'CRITICO', stopped: 'PARADO', 'no-data': 'SEM DADOS' };
        const [r, g, b2] = stC[st] || stC['no-data'];
        doc.setTextColor(30, 41, 59); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        doc.text(t.name.substring(0, 22), 14, y + 5.5);
        doc.text(lat ? fmtKg(lat.stockKg) : '--', 72, y + 5.5);
        doc.text(avg ? fmtKg(avg) : '--', 100, y + 5.5);
        doc.text(avg ? fmtKg(avg * 7) : '--', 127, y + 5.5);
        doc.text(d !== null ? d + ' dias' : '--', 152, y + 5.5);
        doc.text(String(t.boxesPerHeight), 178, y + 5.5);
        doc.setTextColor(r, g, b2); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
        doc.text(stN[st], 192, y + 5.5);
        doc.setDrawColor(241, 245, 249); doc.setLineWidth(0.2); doc.line(10, y + 8, W - 10, y + 8);
        y += 9;
    });
    y += 8;
    if (y < 255) {
        doc.setDrawColor(226, 232, 240); doc.line(10, y, W - 10, y); y += 6;
        doc.setFontSize(10); doc.setTextColor(59, 130, 246); doc.setFont('helvetica', 'bold');
        doc.text('ANALISE DA IA INDUSTRIAL (IIE)', 10, y); y += 6;
        doc.setFillColor(240, 244, 255); doc.setDrawColor(199, 220, 254); doc.roundedRect(10, y, W - 20, 30, 2, 2, 'FD'); y += 6;
        doc.setFontSize(8); doc.setTextColor(51, 65, 85); doc.setFont('helvetica', 'normal');
        const lines = doc.splitTextToSize(IIE.aiSummary(), W - 26);
        doc.text(lines, 14, y);
    }
    doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.line(10, 287, W - 10, 287);
    doc.text('Embalagens Tatui — Sistema IIE de Controle de Estoque', 10, 292);
    doc.text(`${ds} | v3.2`, W - 10, 292, { align: 'right' });
    doc.save(`tatui_fios_${type}_${repPeriod}_${today()}.pdf`);
    toast('PDF exportado com sucesso');
}

/* ── ALERTS SHEET ── */
const shAlerts = document.getElementById('sh-alerts');
if (shAlerts) {
    shAlerts.addEventListener('transitionstart', () => {
        const body = document.getElementById('sh-alerts-body');
        if (!body) return;
        const alerts = IIE.alerts();
        const typeMap = { red: 'alert-red', amber: 'alert-amber', blue: 'alert-blue', green: 'alert-green', gray: 'alert-gray' };
        if (!alerts.length) {
            body.innerHTML = '<div class="empty-state"><i class="fa fa-check-circle" style="color:var(--green)"></i><h3>Sem Alertas</h3><p>Todos os fios em situacao normal.</p></div>';
            return;
        }
        body.innerHTML = alerts.map(a =>
            `<div class="alert-item ${typeMap[a.type] || 'alert-gray'}"><i class="fa ${a.icon} alert-icon"></i><div><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div></div></div>`
        ).join('');
    });
}

/* ── SETTINGS ── */
function exportData() {
    const blob = new Blob([JSON.stringify({ threads, counts, days: daysMeta, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = `tatui_fios_${today()}.json`;
    a.click(); URL.revokeObjectURL(u);
    toast('Backup exportado');
}

async function confirmClear() {
    if (!confirm('Apagar TODOS os dados permanentemente?')) return;
    for (const t of threads) await dbDel('threads', t.id);
    for (const c of counts) await dbDel('counts', c.id);
    for (const k of Object.keys(daysMeta)) await dbDel('days', k);
    threads = []; counts = []; daysMeta = {};
    closeSheet(); renderDash(); renderStock();
    toast('Dados removidos');
}

function updateTopbarDate() {
    const now = new Date();
    const el = document.getElementById('topbar-date');
    if (el) el.textContent = now.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

/* ══════════════════════════════════════════════════════════════
   SEED: PRÉ-CARGA DE FIOS
══════════════════════════════════════════════════════════════ */
async function seedThreads() {
    const existing = await dbAll('threads');
    if (existing.length > 0) return;
    const fios = [
        { name: 'Nylon Trama', wpb: 14, bph: 7 },
        { name: 'Nylon Urdume', wpb: 14, bph: 7 },
        { name: 'Vermelho Variados', wpb: 22, bph: 7 },
        { name: 'Vermelho Fechado  ', wpb: 1, bph: 7 },
        { name: 'Cristal', wpb: 22, bph: 7 },
        { name: 'Bege Fechado', wpb: 22, bph: 7 },
        { name: 'Azul Fechado  ', wpb: 1, bph: 7 },
        { name: 'Verde Flat  ', wpb: 1, bph: 7 },
        { name: 'Amarelo Flat  ', wpb: 1, bph: 7 },
        { name: 'Asterix Pipoca', wpb: 22, bph: 7 },
        { name: 'Azul Aberto', wpb: 22, bph: 7 },
        { name: 'Vermelho Furtado', wpb: 22, bph: 7 },
        { name: 'Bege Juta Aberto', wpb: 22, bph: 7 },
        { name: 'Bege Juta TB', wpb: 22, bph: 7 },
        { name: 'Asterix Aberto Teste', wpb: 1, bph: 7 },
        { name: 'Asterix Fechado Teste', wpb: 1, bph: 7 },
        { name: 'Vermelho Fechado Teste', wpb: 1, bph: 7 },
        { name: 'Vermelho Aberto Teste', wpb: 1, bph: 7 },
        { name: 'Trama / Urdume', wpb: 14, bph: 7 },
        { name: 'Clemente 450/90 IND', wpb: 6.2, bph: 7 },
        { name: 'Clemente 450/90 XV', wpb: 6.2, bph: 7 },
        { name: 'Clemente 450 Gaiola SSM', wpb: 6.2, bph: 7 },
        { name: 'SSM Urdume', wpb: 3.5, bph: 7 },
        { name: 'SSM Trama', wpb: 14, bph: 7 },
    ];

    const base = new Date('2025-01-01T00:00:00.000Z').getTime();
    const list = fios.map((f, i) => ({
        id: uid(), name: f.name, weightPerBox: f.wpb, boxesPerHeight: f.bph,
        createdAt: new Date(base + i).toISOString()
    }));
    await dbPutBatch('threads', list);
    threads.push(...list);
}

/* ══════════════════════════════════════════════════════════════
   SEED: DADOS HISTÓRICOS
   - Datas armazenadas SEMPRE como YYYY-MM-DD estrito
   - Sem timezone, sem ISO timestamp no campo date
══════════════════════════════════════════════════════════════ */
async function seedHistoricalData() {
    const allThreads = await dbAll('threads');
    if (allThreads.length < 18) return;
    allThreads.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    const historicalData = [
        ['2025-05-01', [4946, 3216, 364, 164, 442, 76, 131, 466, 464, 2396, 106, 994, 574, 6288, 1014, 0, 616, 594]],
        ['2025-05-02', [5884, 3160, 364, 164, 398, 890, 131, 466, 464, 2396, 106, 994, 574, 7072, 1014, 0, 616, 594]],
        ['2025-05-04', [3614, 2770, 364, 164, 376, 868, 131, 466, 464, 2396, 106, 994, 552, 6640, 1014, 0, 616, 594]],
        ['2025-05-05', [2935, 3183, 364, 164, 376, 824, 131, 444, 442, 2396, 106, 994, 508, 6368, 1014, 0, 616, 594]],
        ['2025-05-06', [4713, 2315, 364, 164, 376, 802, 131, 444, 442, 2396, 106, 994, 486, 7600, 1014, 0, 616, 594]],
        ['2025-05-07', [5043, 2023, 364, 142, 354, 780, 109, 444, 442, 2396, 106, 994, 464, 7880, 1014, 0, 616, 594]],
        ['2025-05-08', [5404, 2282, 364, 142, 332, 736, 109, 422, 418, 2396, 106, 994, 420, 8352, 1014, 0, 616, 594]],
        ['2025-05-09', [6365, 2077, 364, 120, 288, 714, 109, 400, 396, 2396, 106, 994, 398, 8896, 1014, 0, 616, 594]],
        ['2025-05-11', [5977, 2661, 364, 120, 244, 692, 109, 378, 374, 2396, 106, 994, 376, 9304, 1014, 0, 616, 594]],
        ['2025-05-12', [5508, 1758, 364, 120, 1270, 670, 109, 356, 352, 2396, 106, 994, 1376, 9632, 1014, 0, 616, 594]],
        ['2025-05-13', [6099, 1783, 364, 120, 1226, 648, 109, 356, 352, 2396, 106, 994, 1332, 10212, 1014, 0, 616, 594]],
        ['2025-05-14', [6307, 1883, 364, 120, 1182, 626, 109, 356, 352, 2396, 106, 994, 1288, 11424, 1014, 0, 616, 594]],
        ['2025-05-15', [6538, 2002, 364, 120, 1138, 604, 109, 356, 352, 2396, 106, 994, 1244, 12464, 1014, 0, 616, 594]],
        ['2025-05-16', [7812, 2324, 364, 120, 1094, 582, 109, 356, 352, 2396, 106, 994, 1200, 12164, 1014, 0, 616, 594]],
        ['2025-05-18', [7385, 3465, 364, 120, 1050, 538, 109, 356, 352, 2396, 106, 994, 1156, 11072, 1014, 0, 616, 594]],
        ['2025-05-19', [7364, 3738, 364, 120, 1028, 516, 109, 356, 352, 2396, 106, 994, 1134, 9984, 1014, 0, 616, 594]],
        ['2025-05-20', [10490, 3206, 364, 120, 1006, 494, 109, 356, 352, 2396, 106, 994, 1112, 9120, 1014, 0, 616, 594]],
        ['2025-05-21', [12470, 3755, 364, 120, 960, 314, 109, 356, 352, 2396, 106, 994, 1090, 8421, 1014, 0, 616, 594]],
    ];

    const existingCounts = await dbAll('counts');
    const existingKeys = new Set(
        existingCounts.map(c => `${c.threadId}|${toYMD(c.date) || c.date}`)
    );

    const toInsert = [];
    for (const [rawDate, values] of historicalData) {
        const nd = rawDate;
        for (let i = 0; i < allThreads.length && i < values.length; i++) {
            const thread = allThreads[i];
            const kg = values[i];
            const key = `${thread.id}|${nd}`;
            if (existingKeys.has(key)) continue;
            const totalBoxes = Math.round(kg / thread.weightPerBox);
            toInsert.push({
                threadId: thread.id,
                date: nd,
                heights: 0,
                looseBoxes: totalBoxes,
                production: 0,
                totalBoxes: totalBoxes,
                stockKg: kg,
                timestamp: `${nd}T08:00:00.000Z`,
                historicalSeed: true
            });
        }
    }

    if (!toInsert.length) {
        console.log('[IIE] Historico ja completo — nenhuma insercao necessaria.');
        return;
    }

    const inserted = await dbPutBatch('counts', toInsert);
    inserted.forEach(rec => counts.push(rec));
    console.log(`[IIE] Historico inserido: ${inserted.length} registros`);
}

/* ══════════════════════════════════════════════════════════════
   INIT — Sequência definitiva
   CORREÇÃO PRINCIPAL: calYear/calMonth são sempre setados para
   HOJE (data real do dispositivo), não para o dado mais recente
   do seed histórico. O usuário navega para o passado quando quiser.
══════════════════════════════════════════════════════════════ */
async function init() {
    await initDB();
    await seedThreads();

    threads = await dbAll('threads');

    const rawCounts = await dbAll('counts');
    counts = rawCounts.map(c => ({ ...c, date: toYMD(c.date) || c.date }));

    const dArr = await dbAll('days');
    daysMeta = {};
    dArr.forEach(d => { daysMeta[toYMD(d.date) || d.date] = d; });

    await seedHistoricalData();

    const allCounts = await dbAll('counts');
    counts = allCounts.map(c => ({ ...c, date: toYMD(c.date) || c.date }));

    console.log(`[IIE] Pronto: ${threads.length} fios | ${counts.length} contagens`);

    // ── CORREÇÃO: calendário sempre abre no mês atual (hoje) ──
    // Dados históricos de 2025 ficam acessíveis via navegação (botão ‹ )
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();

    // UI inicial
    const secAlt = document.getElementById('sec-alturas');
    const secAvul = document.getElementById('sec-avulsas');
    const secProd = document.getElementById('sec-producao');
    const secMist = document.getElementById('sec-mistas');
    if (secAlt) secAlt.style.display = 'block';
    if (secAvul) secAvul.style.display = 'none';
    if (secProd) secProd.style.display = 'none';
    if (secMist) secMist.style.display = 'none';

    updateTopbarDate();
    renderDash();
    setInterval(updateTopbarDate, 60000);
}

init();
