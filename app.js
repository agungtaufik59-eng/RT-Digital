// ============ STATE ============
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwG7Uzrv0gyqqNM78D6cvBvs1tjAn937XyAqUb6cTXrGwNRjiIwaftnYo2QPKQ24h1t/exec';

let session = { token: null, user: null };
let currentPage = 'home';
let suratFilter = 'ALL';

// ============ BACK GUARD (History API) ============
let backGuardReady = false;
let lastSilentPop = 0;
let _reArmTimer = null;

function startBackGuard() {
  if (backGuardReady) return;
  backGuardReady = true;
  try { history.pushState({ rtGuard: 1 }, ''); } catch(e) {}
}

function pushGuard() {
  if (!backGuardReady) return;
  try { history.pushState({ rtGuard: 1 }, ''); } catch(e) {}
}

function silentPop() {
  if (!backGuardReady) return;
  lastSilentPop = Date.now();
  try { history.back(); } catch(e) {}
}

/**
 * Re-arm back guard dengan jeda.
 * Di PWA, pushState langsung di popstate handler kadang "kalah cepat"
 * dengan history.back() browser → guard habis → back berikutnya menutup app.
 * Delay 60ms memberi waktu browser settle sebelum kita push guard baru.
 */
function reArmBackGuard() {
  if (_reArmTimer) clearTimeout(_reArmTimer);
  _reArmTimer = setTimeout(function() {
    _reArmTimer = null;
    if (backGuardReady) pushGuard();
  }, 60);
}

function syncAppBarBack() {
  try {
    const appBar = document.querySelector('.app-bar');
    if (!appBar) return;

    // Halaman yang punya header sendiri (page-app-bar menggantikan app-bar global)
    const ownHeaderPages = ['warga', 'kampanye'];

    // Iuran DETAIL punya tombol back sendiri di blok-detail-header
    const isIuranDetail = (currentPage === 'iuran' && typeof iuranView !== 'undefined' && iuranView === 'DETAIL');

    // Sembunyikan app-bar global di halaman own-header
    appBar.style.display = ownHeaderPages.includes(currentPage) ? 'none' : 'flex';

    // Kapan tombol back di app-bar harus muncul?
    const shouldShowBack =
      !ownHeaderPages.includes(currentPage) &&
      currentPage !== 'home' &&
      !isIuranDetail;

    const existingBack = document.getElementById('appBackBtn');

    if (shouldShowBack) {
      if (!existingBack) {
        const btn = document.createElement('button');
        btn.id = 'appBackBtn';
        btn.className = 'icon-btn';
        btn.textContent = '←';
        btn.onclick = () => history.back();
        appBar.insertBefore(btn, appBar.firstChild);
      } else {
        existingBack.style.display = '';
      }
    } else if (existingBack) {
      existingBack.remove();
    }
  } catch (e) {
    console.error('syncAppBarBack error:', e);
  }
}

window.addEventListener('popstate', function(e) {
  // 0. Custom dialog terbuka? → tutup dialog (Biarkan sama)
  if (!$('#confirmDialog').classList.contains('hidden')) {
    const btnCancel = $('#cfmBtnCancel');
    if (btnCancel && btnCancel.onclick) btnCancel.onclick();
    else $('#confirmDialog').classList.add('hidden');
    return;
  }
  if (!$('#promptDialog').classList.contains('hidden')) {
    const btnCancel = $('#prmBtnCancel');
    if (btnCancel && btnCancel.onclick) btnCancel.onclick();
    else $('#promptDialog').classList.add('hidden');
    return;
  }
  if (!$('#alertDialog').classList.contains('hidden')) {
    const btnOk = $('#altBtnOk');
    if (btnOk && btnOk.onclick) btnOk.onclick();
    else $('#alertDialog').classList.add('hidden');
    return;
  }

  // 1. Search dropdown terbuka? (Biarkan sama)
  const sList = document.querySelector('.search-list.open');
  if (sList) { sList.classList.remove('open'); return; }

  // 2. Modal terbuka? (Biarkan sama)
  if (!$('#modal').classList.contains('hidden')) {
    closeModal(true); return;
  }

  // 3. Iuran detail blok? (Biarkan sama)
  if (currentPage === 'iuran' && iuranView === 'DETAIL') {
    backToRingkasan(true); return;
  }

  // 4. Kampanye detail view (Biarkan sama)
  if (currentPage === 'kampanye' && kampanyeView === 'DETAIL') {
    backToKampanyeList(true); return;
  }

  // 5. Halaman warga — KK expanded? (Biarkan sama)
  if (currentPage === 'warga' && expandedKK) {
    collapseExpandedKK(true); return;
  }

  // ==============================================
  // 6. Router Navigasi: Cek state history baru
  // ==============================================
  const statePage = e.state ? e.state.rtPage : 'home';

  // Jika kita tekan back dan halaman state bukan halaman saat ini, render halamannya
  if (currentPage !== statePage) {
     doNavigate(statePage, true);
  } else if (currentPage !== 'home') {
     // Fallback aman: jika entah bagaimana state hilang tapi kita bukan di home
     doNavigate('home', true);
  }
});

// ============ CACHE (SPA) ============
const cache = {
  home:   { data: null, dirty: true },
  iuran:  { data: null, dirty: true },
  surat:  { data: null, dirty: true },
  users:  { data: null, dirty: true }
};

// ===== State kampanye =====
let kampanyeCache = { data: null, dirty: true };
let kampanyeDetailCache = {};
let kampanyeSayaCache = { data: null, dirty: true };
let kampanyeView = 'LIST';
let currentKampanyeId = null;
let kampanyeWargaFilter = { q: '' };

function invalidateKampanye() {
  kampanyeCache.dirty = true;
  kampanyeSayaCache.dirty = true;
  Object.keys(kampanyeDetailCache).forEach(id => {
    if (kampanyeDetailCache[id]) kampanyeDetailCache[id].dirty = true;
  });
}

function invalidateKampanyeDetail(id) {
  if (id && kampanyeDetailCache[id]) {
    kampanyeDetailCache[id].dirty = true;
  } else {
    kampanyeDetailCache = {};
  }
}

function invalidate(...keys){
  keys.forEach(k => { if (cache[k]) cache[k].dirty = true; });
}
function invalidateAll(){
  Object.keys(cache).forEach(k => cache[k].dirty = true);
}
function isFresh(key){
  return !cache[key].dirty && cache[key].data !== null;
}

function invalidateKeuangan(){
  if (cache.home) cache.home.dirty = true;
  if (cache.iuran) cache.iuran.dirty = true;
  if (cache.surat) cache.surat.dirty = true;
  Object.keys(cache).forEach(k => {
    if (k.startsWith('kas_') || k.startsWith('riwayat_') || k.startsWith('iuran_') || k.startsWith('blokdetail_')) {
      cache[k].dirty = true;
    }
  });
  // Invalidasi kampanye (progress ikut berubah saat ada iuran kampanye)
  invalidateKampanye();
}

// ============ API WRAPPER (fetch ke GAS JSON API) ============
async function api(fn, ...args) {
  // Auto-detect: kalau arg pertama = session.token, buang dari args
  // (karena token sudah otomatis dikirim di body)
  let filteredArgs = args;
  if (args.length > 0 && session && args[0] === session.token) {
    filteredArgs = args.slice(1);
  }

  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        fn: fn,
        token: (session && session.token) || '',
        args: filteredArgs
      }),
      redirect: 'follow'
    });

    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }

    const data = await res.json();

    if (!data || typeof data !== 'object') {
      return { ok: false, msg: 'Respons tidak valid dari server' };
    }

    return data;
  } catch (err) {
    console.error('[API Error]', fn, err);
    throw err;
  }
}

// ============ UI HELPERS ============
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

// ============ SUBMIT LOCK (anti double-submit) ============
let _submitLock = false;

function acquireSubmitLock() {
  if (_submitLock) {
    toast('Mohon tunggu, sedang memproses...', 'error');
    return false;
  }
  _submitLock = true;
  return true;
}
function releaseSubmitLock() {
  _submitLock = false;
}

// ============ CUSTOM CONFIRM/ALERT/PROMPT ============
function confirmDialog(message, options) {
  options = options || {};
  return new Promise((resolve) => {
    const title      = options.title      || 'Konfirmasi';
    const icon       = options.icon       || '❓';
    const type       = options.type       || 'primary';
    const okText     = options.okText     || 'Oke';
    const cancelText = options.cancelText || 'Batal';

    const el      = $('#confirmDialog');
    const iconEl  = $('#cfmIcon');
    const titleEl = $('#cfmTitle');
    const msgEl   = $('#cfmMessage');
    const btnOk   = $('#cfmBtnConfirm');
    const btnCxl  = $('#cfmBtnCancel');

    iconEl.textContent  = icon;
    iconEl.className    = 'cfm-icon' + (type !== 'primary' ? ' ' + type : '');
    titleEl.textContent = title;
    msgEl.textContent   = message;
    btnOk.textContent   = okText;
    btnCxl.textContent  = cancelText;
    btnOk.className     = 'cfm-btn confirm' + (type !== 'primary' ? ' ' + type : '');

    el.classList.remove('hidden');
    pushGuard();

    const cleanup = (result) => {
      el.classList.add('hidden');
      btnOk.onclick = null;
      btnCxl.onclick = null;
      el.onclick = null;
      resolve(result);
      silentPop();
    };

    btnOk.onclick  = () => cleanup(true);
    btnCxl.onclick = () => cleanup(false);
    el.onclick = (e) => { if (e.target === el) cleanup(false); };
  });
}

function promptDialog(message, defaultValue, options) {
  options = options || {};
  defaultValue = defaultValue || '';
  return new Promise((resolve) => {
    const title       = options.title       || 'Input';
    const icon        = options.icon        || '✏️';
    const type        = options.type        || 'primary';
    const okText      = options.okText      || 'Simpan';
    const cancelText  = options.cancelText  || 'Batal';
    const placeholder = options.placeholder || '';

    const el      = $('#promptDialog');
    const iconEl  = $('#prmIcon');
    const titleEl = $('#prmTitle');
    const msgEl   = $('#prmMessage');
    const input   = $('#prmInput');
    const btnOk   = $('#prmBtnConfirm');
    const btnCxl  = $('#prmBtnCancel');

    iconEl.textContent  = icon;
    iconEl.className    = 'cfm-icon' + (type !== 'primary' ? ' ' + type : '');
    titleEl.textContent = title;
    msgEl.textContent   = message;
    input.value         = defaultValue;
    input.placeholder   = placeholder;
    btnOk.textContent   = okText;
    btnCxl.textContent  = cancelText;
    btnOk.className     = 'cfm-btn confirm' + (type !== 'primary' ? ' ' + type : '');

    el.classList.remove('hidden');
    pushGuard();
    setTimeout(() => input.focus(), 150);

    const cleanup = (result) => {
      el.classList.add('hidden');
      btnOk.onclick = null;
      btnCxl.onclick = null;
      el.onclick = null;
      input.onkeydown = null;
      resolve(result);
      silentPop();
    };

    const submit = () => {
      const val = input.value.trim();
      if (!val) { input.focus(); return; }
      cleanup(val);
    };

    btnOk.onclick  = submit;
    btnCxl.onclick = () => cleanup(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
    };
    el.onclick = (e) => { if (e.target === el) cleanup(null); };
  });
}

function alertDialog(message, options) {
  options = options || {};
  return new Promise((resolve) => {
    const title = options.title || 'Info';
    const icon  = options.icon  || 'ℹ️';
    const type  = options.type  || 'primary';

    const el      = $('#alertDialog');
    const iconEl  = $('#altIcon');
    const titleEl = $('#altTitle');
    const msgEl   = $('#altMessage');
    const btnOk   = $('#altBtnOk');

    iconEl.textContent  = icon;
    iconEl.className    = 'cfm-icon' + (type !== 'primary' ? ' ' + type : '');
    titleEl.textContent = title;
    msgEl.textContent   = message;

    el.classList.remove('hidden');
    pushGuard();

    const cleanup = () => {
      el.classList.add('hidden');
      btnOk.onclick = null;
      el.onclick = null;
      resolve();
      silentPop();
    };
    btnOk.onclick = cleanup;
    el.onclick = (e) => { if (e.target === el) cleanup(); };
  });
}

function showLoading(show=true){ $('#loading').classList.toggle('hidden', !show); }

function toast(msg, type=''){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.className = 'toast ' + type, 2600);
}

// ============ PROCESS DIALOG ============
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function showProcess(title, message) {
  const el = $('#processDialog');
  if (!el) return;
  $('#processTitle').textContent = title || 'Memproses...';
  $('#processMessage').textContent = message || 'Mohon tunggu sebentar';
  const icon = $('#processIcon');
  icon.className = 'process-icon';
  icon.innerHTML = '<div class="process-spinner"></div>';
  el.classList.remove('hidden');
}

function processSuccess(title, message) {
  const icon = $('#processIcon');
  icon.className = 'process-icon success';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  $('#processTitle').textContent = title || 'Berhasil!';
  $('#processMessage').textContent = message || '';
}

function processError(title, message) {
  const icon = $('#processIcon');
  icon.className = 'process-icon error';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  $('#processTitle').textContent = title || 'Gagal';
  $('#processMessage').textContent = message || '';
}

function hideProcess() {
  const el = $('#processDialog');
  if (el) el.classList.add('hidden');
}

function openModal(title, html){
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  pushGuard();
}

function closeModal(silent=false){
  $('#modal').classList.add('hidden');
  window._suratPendingFile = null;
  _submitLock = false;
  if (!silent) silentPop();
}

function rupiah(n){
  n = Number(n) || 0;
  return 'Rp ' + n.toLocaleString('id-ID');
}

function tgl(d){
  if (!d) return '-';
  let dt = new Date(d);
  if (isNaN(dt) && typeof d === 'string' && d.includes('/')) {
    const p = d.split('/');
    if (p.length === 3) dt = new Date(p[2] + '-' + p[1] + '-' + p[0]);
  }
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('id-ID', {day:'2-digit', month:'short', year:'numeric'});
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function badge(status){
  const s = String(status||'').toLowerCase();
  const map = { pending:'pending', verified:'verified', rejected:'rejected',
                diajukan:'diajukan', diproses:'diproses', selesai:'selesai', ditolak:'ditolak' };
  return '<span class="badge ' + (map[s]||'') + '">' + esc(status) + '</span>';
}

function skeleton(){
  return `
    <div class="skeleton-card">
      <div class="sk-line w40"></div>
      <div class="sk-line tall w80"></div>
      <div class="sk-line w60"></div>
    </div>
    <div class="stats-grid">
      <div class="skeleton-card" style="margin:0"><div class="sk-line w60"></div><div class="sk-line tall w80"></div></div>
      <div class="skeleton-card" style="margin:0"><div class="sk-line w60"></div><div class="sk-line tall w80"></div></div>
    </div>
    <div class="skeleton-card"><div class="sk-line w40"></div><div class="sk-line w80"></div><div class="sk-line w60"></div></div>
  `;
}

// ============ SESSION ============
function saveSession(){ try{ localStorage.setItem('rtdigital', JSON.stringify(session)); }catch(e){} }
function loadSession(){
  try{
    const v = localStorage.getItem('rtdigital');
    if (v) session = JSON.parse(v) || session;
  }catch(e){}
}
function clearSession(){
  session = { token:null, user:null };
  try{ localStorage.removeItem('rtdigital'); }catch(e){}
  invalidateAll();
}

function isAdmin(){ return session.user && ['ADMIN','BENDAHARA','SEKRETARIS'].includes(session.user.role); }
function isBendahara(){ return session.user && ['ADMIN','BENDAHARA'].includes(session.user.role); }
function isSekretaris(){ return session.user && ['ADMIN','SEKRETARIS'].includes(session.user.role); }

// ============ AUTH ============
async function doLogin(){
  const phone = $('#loginPhone').value.trim();
  const pwd = $('#loginPwd').value;
  if (!phone || !pwd) return toast('Isi nomor HP dan password', 'error');
  showLoading(true);
  try{
    const res = await api('login', phone, pwd);
    if (!res.ok){ showLoading(false); return toast(res.msg || 'Gagal login','error'); }
    session.token = res.token;
    session.user = res.user;
    saveSession();
    invalidateAll();
    showLoading(false);
    enterApp();
    startBackGuard();
    toast('Selamat datang, ' + res.user.nama, 'success');

    // Prefetch semua cache di background (paralel)
    setTimeout(() => {
      if (['ADMIN','BENDAHARA','SEKRETARIS'].includes(res.user.role)) {
        prefetchWargaCache();
        prefetchRTCache();
      }
      prefetchMenuUtama();
    }, 500);
  }catch(e){ showLoading(false); toast('Error: ' + e.message,'error'); }
}

async function doLogout(){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Keluar dari aplikasi?', {
      title: 'Konfirmasi Keluar', icon: '🚪', type: 'danger',
      okText: 'Keluar', cancelText: 'Batal'
    });
    if (!ok) return;

    try { await api('logout', session.token); } catch(e) {}
    clearSession();
    resetAllCache();
    backGuardReady = false;
    $('#appScreen').classList.remove('active');
    $('#loginScreen').classList.add('active');
    $('#loginPwd').value = '';
  } finally {
    releaseSubmitLock();
  }
}

function resetAllCache(){
  Object.keys(cache).forEach(k => { delete cache[k]; });

  cache.home   = { data: null, dirty: true };
  cache.iuran  = { data: null, dirty: true };
  cache.surat  = { data: null, dirty: true };
  cache.users  = { data: null, dirty: true };

  anggotaCache = {};
  selectedWarga = null;
  expandedKK = null;

  // Clear semua cache (memory + localStorage)
  clearWargaCache();
  clearRTCache();
  invalidateKeluargaCache();

  kasFilter = { bulan: null };
  riwayatFilter = { tahun: null };
  wargaFilter = { blok: 'ALL', q: '' };
  iuranFilter = { bulan: null, blok: 'ALL', status: 'ALL' };
  suratFilter = 'ALL';

  // ===== Reset state kampanye =====
  kampanyeCache = { data: null, dirty: true };
  kampanyeDetailCache = {};
  kampanyeSayaCache = { data: null, dirty: true };
  kampanyeView = 'LIST';
  currentKampanyeId = null;
  kampanyeWargaFilter = { q: '' };
}

// ============ ROUTER ============
function enterApp(){
  $('#loginScreen').classList.remove('active');
  $('#appScreen').classList.add('active');
  $('#rtLabel').textContent = session.user.rt_id + ' • ' + (session.user.role||'WARGA');
  currentPage = '';
  navigate('home', true);
}

function navigate(page, force, silent){
  force = force || false;
  silent = silent || false;
  if (page === currentPage && !force) return;

  doNavigate(page, true);

  // Perbaikan History API: Selalu push state baru yang valid kecuali silent
  if (!silent) {
    try {
      history.pushState({ rtPage: page }, '', '#' + page);
    } catch(e) {}
  }
}

function doNavigate(page, renderImmediate) {
  currentPage = page;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  const titles = {
    home:'Beranda', iuran:'Iuran & Kas', surat:'Surat Menyurat', profil:'Profil',
    warga:'Data Warga', kas:'Kas RT', riwayat:'Riwayat Iuran Saya',
    kampanye: 'Kampanye RT'
  };
  $('#pageTitle').textContent = titles[page] || page;

  const nav = document.querySelector('.bottom-nav');
  const hiddenPages = ['warga', 'kas', 'riwayat', 'kampanye'];
  if (nav) nav.style.display = hiddenPages.includes(page) ? 'none' : 'flex';

  syncAppBarBack();

  if (page === 'home')    return renderHome(false);
  if (page === 'iuran')   return renderIuran(false);
  if (page === 'surat')   return renderSurat(false);
  if (page === 'profil')  return renderProfil();
  if (page === 'warga')   return renderWarga(false);
  if (page === 'kas')     return renderKas(false);
  if (page === 'riwayat') return renderRiwayat(false);
  if (page === 'kampanye') return renderKampanye(false);
}

// ============ HOME ============
async function renderHome(force){
  force = force || false;
  const main = $('#mainContent');
  const isWarga = session.user.role === 'WARGA';

  if (!force && isFresh('home')) return renderHomeHTML(cache.home.data);
  if (!cache.home.data) main.innerHTML = skeleton();

  try{
    const apiFn = isWarga ? 'getWargaDashboard' : 'getDashboard';
    const res = await api(apiFn, session.token);
    if (!res.ok){
      if (!cache.home.data) main.innerHTML = '<div class="empty"><span class="icon">⚠️</span>'+esc(res.msg)+'</div>';
      return toast(res.msg,'error');
    }
    cache.home.data = res.data;
    cache.home.dirty = false;
    renderHomeHTML(res.data);
  }catch(e){
    if (!cache.home.data) main.innerHTML = '<div class="empty"><span class="icon">⚠️</span>'+esc(e.message)+'</div>';
    toast('Gagal: '+e.message,'error');
  }
}

function renderHomeHTML(d){
  const main = $('#mainContent');
  const isWarga = session.user.role === 'WARGA';
  const isBend = isBendahara();
  const isSekr = isSekretaris();

  // ==================================================
  // ===== BERANDA WARGA =====
  // ==================================================
  if (isWarga) {
    const ib = d.iuranBulanIni || { status:'BELUM', nominal:0 };
    const statusCls = ib.status === 'VERIFIED' ? 'verified' : (ib.status === 'PENDING' ? 'pending' : 'belum');
    const statusIcon = ib.status === 'VERIFIED' ? '✓' : (ib.status === 'PENDING' ? '⏳' : '⚠');
    const bulanLabel = formatBulan(d.bulanIni);

    const pctTahun = Math.min(100, Math.round(((d.bulanBayar || 0) / 12) * 100));

    // Ring color
    let ringColor = '#eef0f3';
    if (pctTahun >= 80) ringColor = 'var(--success)';
    else if (pctTahun >= 50) ringColor = 'var(--warn)';
    else if (pctTahun > 0) ringColor = 'var(--danger)';

    // Pending state tidak menghitung progres (anggap belum lunas bulan ini)
    const pendingCount = d.pendingCount || 0;

    main.innerHTML = `
      ${renderGreetingHTML()}

      <!-- HERO: SALDO KAS -->
      <div class="hero-card">
        <div class="hero-head">
          <div class="hero-icon">💰</div>
          <div class="hero-label">Saldo Kas RT</div>
        </div>
        <div class="hero-value">${rupiah(d.saldo)}</div>
        <div class="hero-chip">📅 Per ${new Date().toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}</div>
        <button class="hero-btn" onclick="navigate('kas')">📊 Lihat Detail Kas RT →</button>
      </div>

      <!-- KARTU IURAN SAYA -->
      <div class="my-iuran-v2 is-${statusCls}">
        <div class="mi-head">
          <div>
            <div class="mi-title">Iuran Saya</div>
            <div class="mi-subtitle">${esc(bulanLabel)} • Iuran Bulanan</div>
          </div>
          <div class="mi-pill pill-${statusCls}">${statusIcon} ${ib.status === 'VERIFIED' ? 'LUNAS' : (ib.status === 'PENDING' ? 'PENDING' : 'BELUM BAYAR')}</div>
        </div>

        <div class="mi-body">
          <div class="mi-amount-box">
            <div class="mi-amount-label">${ib.status === 'BELUM' ? 'Wajib Bayar' : 'Jumlah Bayar'}</div>
            <div class="mi-amount c-${statusCls}">
              ${ib.status === 'BELUM' ? rupiah(d.iuranBulanan || 50000) : rupiah(ib.nominal)}
            </div>
            <div class="mi-amount-meta">
              ${ib.status === 'BELUM'
                ? 'Hubungi Bendahara untuk bayar'
                : 'Dibayar: <b>' + tgl(ib.tgl_bayar) + '</b> • ' + esc(ib.metode || '')
              }
              ${ib.status === 'PENDING' ? '<br>⏳ Menunggu verifikasi admin' : ''}
            </div>
          </div>

          <div class="ring-progress" style="background:conic-gradient(${ringColor} 0% ${pctTahun}%, #eef0f3 ${pctTahun}% 100%)">
            <div class="ring-text">
              <div class="ring-num">${d.bulanBayar || 0}<span style="font-size:11px;color:#888">/12</span></div>
              <div class="ring-label">Bulan</div>
            </div>
          </div>
        </div>

        <button class="mi-cta" onclick="navigate('riwayat')">📜 Lihat Histori Lengkap →</button>
      </div>

      ${pendingCount > 0 ? `
        <div class="stats-card-v2 st-orange" style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="st-icon">⏳</div>
            <div>
              <div class="st-label">Menunggu Verifikasi</div>
              <div class="st-value" style="font-size:14px">${pendingCount} pembayaran</div>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="section-title">Aksi Cepat</div>
      <div class="quick-grid">
        ${tile('teal', '📄', 'Ajukan Surat', 'formAjukanSurat()')}
        ${tile('indigo', '📊', 'Kas RT', "navigate('kas')")}
        ${tile('warn', '📜', 'Riwayat Iuran', "navigate('riwayat')")}
        ${tile('pink', '👤', 'Profil', "navigate('profil')")}
      </div>

      <div class="section-title">Program RT</div>
      <div class="quick-grid">
        ${tile('purple', '🎯', 'Kampanye RT', "navigate('kampanye')")}
      </div>
    `;
    return;
  }

  // ==================================================
  // ===== BERANDA ADMIN/BENDAHARA/SEKRETARIS =====
  // ==================================================
  let mgmtTiles = '';
  if (isBend) {
    mgmtTiles += tile('danger', '💸', 'Pengeluaran', 'formPengeluaran()');
    mgmtTiles += tile('warn', '✔', 'Verifikasi Iuran', 'showPendingIuran()', d.pending);
  }
  if (isSekr) {
    mgmtTiles += tile('indigo', '📋', 'Kelola Surat', "navigate('surat')", d.suratPending);
  }
  if (isBend) {
    mgmtTiles += tile('purple', '👥', 'Data Warga', "navigate('warga')");
    mgmtTiles += tile('pink', '🎯', 'Kampanye RT', "navigate('kampanye')");
  }

  main.innerHTML = `
    ${renderGreetingHTML()}

    <!-- HERO: SALDO KAS -->
    <div class="hero-card">
      <div class="hero-head">
        <div class="hero-icon">💰</div>
        <div class="hero-label">Saldo Kas RT</div>
      </div>
      <div class="hero-value">${rupiah(d.saldo)}</div>
      <div class="hero-chip">📅 Per ${new Date().toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}</div>
    </div>

    <!-- STATS GRID -->
    <div class="stats-grid-v2">
      <div class="stats-card-v2 st-green">
        <div class="st-icon">💰</div>
        <div class="st-label">Iuran Bulan Ini</div>
        <div class="st-value">${rupiah(d.masukBulanIni)}</div>
        <div class="st-bar"></div>
      </div>
      <div class="stats-card-v2 st-red">
        <div class="st-icon">💸</div>
        <div class="st-label">Pengeluaran</div>
        <div class="st-value">${rupiah(d.keluar)}</div>
        <div class="st-bar"></div>
      </div>
      <div class="stats-card-v2 st-blue">
        <div class="st-icon">👥</div>
        <div class="st-label">Warga Aktif</div>
        <div class="st-value">${d.totalWarga}<small>KK</small></div>
        <div class="st-bar"></div>
      </div>
      <div class="stats-card-v2 ${d.belumBayar > 0 ? 'st-orange' : 'st-green'}">
        <div class="st-icon">${d.belumBayar > 0 ? '⚠️' : '✅'}</div>
        <div class="st-label">Belum Bayar</div>
        <div class="st-value">${d.belumBayar || 0}<small>KK</small></div>
        <div class="st-bar"></div>
      </div>
    </div>

    <div class="section-title">Aksi Cepat</div>
    <div class="quick-grid">
      ${tile('primary', '💰', 'Catat Iuran', 'formBayarIuran()')}
      ${tile('teal', '📄', 'Ajukan Surat', 'formAjukanSurat()')}
      ${tile('success', '📊', 'Lihat Iuran', "navigate('iuran')")}
      ${tile('pink', '👤', 'Profil', "navigate('profil')")}
    </div>

    ${mgmtTiles ? `
      <div class="section-title">Manajemen Admin</div>
      <div class="quick-grid">${mgmtTiles}</div>
    ` : ''}
  `;
}

function tile(color, icon, label, onclick, badgeCount){
  const badge = badgeCount > 0 ? '<span class="quick-badge">' + badgeCount + '</span>' : '';
  return `
    <button class="quick-tile" onclick="${onclick}">
      <div class="quick-icon ${color}">${icon}${badge}</div>
      <span class="quick-label">${esc(label)}</span>
    </button>
  `;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 11) return 'Selamat pagi';
  if (h < 15) return 'Selamat siang';
  if (h < 18) return 'Selamat sore';
  return 'Selamat malam';
}

function renderGreetingHTML() {
  const u = session.user || {};
  const fullName = String(u.nama || 'Warga').trim();
  const firstName = fullName.split(/\s+/)[0] || 'Warga';
  const initial = firstName.charAt(0).toUpperCase();
  const greeting = getGreeting();
  const dateStr = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  return `
    <div class="greeting">
      <div class="greeting-text">
        <span class="greeting-hello">${esc(greeting)},</span>
        <h2 class="greeting-name">${esc(firstName)} <span class="wave">👋</span></h2>
        <span class="greeting-date">${esc(dateStr)}</span>
      </div>
      <div class="greeting-avatar">${esc(initial)}</div>
    </div>
  `;
}

// ============ IURAN ============
let iuranFilter = { bulan: null, blok: 'ALL', status: 'ALL' };
let iuranMode = 'BLOK';
let iuranView = 'RINGKASAN';
let iuranDetailBlok = null;

async function renderIuran(force){
  force = force || false;
  const main = $('#mainContent');

  if (!iuranFilter.bulan) {
    const now = new Date();
    iuranFilter.bulan = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  }

  const cacheKey = 'iuran_' + iuranFilter.bulan;
  if (force || !cache[cacheKey] || cache[cacheKey].dirty) {
    if (!cache[cacheKey] || !cache[cacheKey].data) main.innerHTML = skeleton();
    try {
      const res = await api('getRingkasanBlok', session.token, iuranFilter.bulan);
      if (!res.ok) return toast(res.msg,'error');
      cache[cacheKey] = { data: res, dirty: false };
    } catch(e) { return toast('Gagal: '+e.message,'error'); }
  }

  renderIuranHTML();
}

function renderIuranHTML(){
  syncAppBarBack();   // ← TAMBAH INI
  const main = $('#mainContent');
  const cacheKey = 'iuran_' + iuranFilter.bulan;
  const data = cache[cacheKey].data;
  const bulanLabel = formatBulan(iuranFilter.bulan);

  const blokOptions = ['ALL'].concat((data.bloks || []).map(b => b.blok));
  const filterBar = `
    <div class="filter-bar">
      <div class="filter-item">
        <label>Bulan</label>
        <input type="month" id="filterBulan" value="${iuranFilter.bulan}">
      </div>
      ${iuranMode === 'DAFTAR' ? `
        <div class="filter-item">
          <label>Blok</label>
          <select id="filterBlok">
            ${blokOptions.map(b => '<option value="' + b + '" ' + (iuranFilter.blok===b?'selected':'') + '>' + (b==='ALL'?'Semua Blok':b) + '</option>').join('')}
          </select>
        </div>
        <div class="filter-item">
          <label>Status</label>
          <select id="filterStatus">
            ${[['ALL','Semua'],['VERIFIED','Terverifikasi'],['PENDING','Pending'],['REJECTED','Ditolak']].map(([v,l]) =>
              '<option value="' + v + '" ' + (iuranFilter.status===v?'selected':'') + '>' + l + '</option>').join('')}
          </select>
        </div>
      ` : ''}
    </div>
  `;

  const toggle = `
    <div class="mode-toggle">
      <button class="${iuranMode==='BLOK'?'active':''}" data-mode="BLOK">🏠 Per Blok</button>
      <button class="${iuranMode==='DAFTAR'?'active':''}" data-mode="DAFTAR">📋 Daftar</button>
    </div>
  `;

  if (iuranView === 'DETAIL' && iuranDetailBlok) {
    main.innerHTML = filterBar + toggle + '<div id="detailArea"></div>';
    renderBlokDetail();
  } else {
    const t = data.total || { total:0, verified:0, pending:0, belum:0, nominal:0 };
    const pct = t.total ? Math.round(t.verified / t.total * 100) : 0;

    let bodyHTML = '';

    // ===== HERO SUMMARY =====
    bodyHTML += `
      <div class="hero-card green">
        <div class="hero-head">
          <div class="hero-icon">📊</div>
          <div class="hero-label">Total Iuran ${esc(bulanLabel)}</div>
        </div>
        <div class="hero-value">${rupiah(t.nominal)}</div>
        <div class="hero-chip">✓ ${t.verified} dari ${t.total} KK terverifikasi (${pct}%)</div>
        <div style="position:relative;z-index:1;margin-top:14px">
          <div style="height:6px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:#fff;border-radius:3px;transition:width .4s"></div>
          </div>
        </div>
      </div>

      <div class="mini-info">
        <span class="dot-success">✓ ${t.verified} Verified</span>
        <span class="dot-warn">⏳ ${t.pending} Pending</span>
        <span class="dot-danger">✗ ${t.belum} Belum</span>
      </div>
    `;

    if (iuranMode === 'BLOK') {
      if (!data.bloks || !data.bloks.length) {
        bodyHTML += '<div class="empty"><span class="icon">📭</span>Tidak ada data blok</div>';
      } else {
        bodyHTML += '<div class="blok-grid-v2">';
        data.bloks.forEach(b => {
          const pctBlok = b.total ? Math.round(b.verified / b.total * 100) : 0;
          let cls = 'bk-danger';
          if (pctBlok >= 80) cls = 'bk-done';
          else if (pctBlok >= 50) cls = 'bk-warn';

          bodyHTML += `
            <div class="blok-card-v2 ${cls}" data-blok="${esc(b.blok)}">
              <div class="bk-head">
                <div class="bk-avatar">${esc(b.blok)}</div>
                <div class="bk-count">${b.verified}/${b.total}</div>
              </div>
              <div class="bk-name">Blok ${esc(b.blok)}</div>
              <div class="bk-nominal">${rupiah(b.nominal)}</div>
              <div class="bk-bar"><div class="bk-bar-fill" style="width:${pctBlok}%"></div></div>
              ${b.belum > 0
                ? '<div class="bk-badge badge-warn">● ' + b.belum + ' belum bayar</div>'
                : '<div class="bk-badge badge-ok">✓ Lunas semua</div>'}
            </div>
          `;
        });
        bodyHTML += '</div>';
      }
    } else {
      bodyHTML += '<div id="daftarArea"><div class="empty">⏳ Memuat daftar...</div></div>';
    }

    main.innerHTML = filterBar + toggle + bodyHTML;
    attachIuranHandlers();

    if (iuranMode === 'DAFTAR') {
      renderIuranDaftar();
    }
  }
}

function attachIuranHandlers(){
  const fb = $('#filterBulan');
  if (fb) fb.onchange = () => {
    iuranFilter.bulan = fb.value;
    iuranView = 'RINGKASAN';
    iuranDetailBlok = null;
    renderIuran(true);
  };

  const fbl = $('#filterBlok');
  if (fbl) fbl.onchange = () => {
    iuranFilter.blok = fbl.value;
    renderIuranDaftar();
  };

  const fst = $('#filterStatus');
  if (fst) fst.onchange = () => {
    iuranFilter.status = fst.value;
    renderIuranDaftar();
  };

  $$('.mode-toggle button').forEach(b => {
    b.onclick = () => {
      iuranMode = b.dataset.mode;
      iuranView = 'RINGKASAN';
      iuranDetailBlok = null;
      if (iuranMode === 'BLOK') iuranFilter.status = 'ALL';
      renderIuranHTML();
    };
  });

  $$('.blok-card-v2').forEach(c => {
    c.onclick = () => {
      iuranDetailBlok = c.dataset.blok;
      iuranView = 'DETAIL';
      renderIuranHTML();
      pushGuard();
    };
  });
}

async function renderIuranDaftar(){
  const area = $('#daftarArea');
  if (!area) return;
  try {
    const filter = { periode: iuranFilter.bulan };
    if (iuranFilter.blok !== 'ALL') filter.blok = iuranFilter.blok;
    if (iuranFilter.status !== 'ALL') filter.status = iuranFilter.status;

    const res = await api('listIuran', session.token, filter);
    if (!res.ok) { area.innerHTML = '<div class="empty">⚠️ '+esc(res.msg)+'</div>'; return; }
    const items = res.data || [];

    if (!items.length) {
      area.innerHTML = '<div class="empty"><span class="icon">📭</span>Belum ada iuran yang cocok</div>';
      return;
    }

    area.innerHTML = items.map(it => `
      <div class="list-item">
        <div class="left">
          <div class="title">${esc(it.nama_kk || it.phone)}</div>
          <div class="sub">${esc(it.blok ? 'Blok '+it.blok : '-')} • ${esc(it.jenis)}${it.periode?' • '+esc(it.periode):''}</div>
          <div class="sub">${esc(it.metode)} ${badge(it.status)}</div>
        </div>
        <div style="text-align:right">
          <div class="amount">${rupiah(it.nominal)}</div>
          ${isBendahara() && it.status==='PENDING' ? `
            <div class="btn-row" style="margin-top:6px">
              <button class="btn success sm" data-approve="${esc(it.id)}">✓</button>
              <button class="btn danger sm" data-reject="${esc(it.id)}">✕</button>
            </div>`:''}
        </div>
      </div>
    `).join('');

    $$('button[data-approve]', area).forEach(b => b.onclick = () => approveIuran(b.dataset.approve));
    $$('button[data-reject]', area).forEach(b => b.onclick = () => rejectIuran(b.dataset.reject));
  } catch(e) {
    area.innerHTML = '<div class="empty">⚠️ '+esc(e.message)+'</div>';
  }
}

async function renderBlokDetail(){
  const area = $('#detailArea');
  if (!area) return;

  const cacheKey = 'blokdetail_' + iuranDetailBlok + '_' + iuranFilter.bulan;

  // ===== CEK CACHE DULU =====
  if (!cache[cacheKey] || cache[cacheKey].dirty) {
    area.innerHTML = '<div class="empty">⏳ Memuat...</div>';
    try {
      const res = await api('getWargaBlokDetail', session.token, iuranDetailBlok, iuranFilter.bulan);
      if (!res.ok) {
        area.innerHTML = '<div class="empty">⚠️ ' + esc(res.msg) + '</div>';
        return;
      }
      cache[cacheKey] = { data: res, dirty: false };
    } catch(e) {
      area.innerHTML = '<div class="empty">⚠️ ' + esc(e.message) + '</div>';
      return;
    }
  }

  // ===== RENDER DARI CACHE (INSTAN) =====
  const res = cache[cacheKey].data;
  const warga = res.warga || [];
  const bulanLabel = formatBulan(iuranFilter.bulan);

  const blokInfo = ((cache['iuran_'+iuranFilter.bulan] && cache['iuran_'+iuranFilter.bulan].data && cache['iuran_'+iuranFilter.bulan].data.bloks) || []).find(b => b.blok === iuranDetailBlok);
  const info = blokInfo || { total: warga.length, verified: 0, pending: 0, belum: 0, nominal: 0 };

  let html = `
    <div class="blok-detail-header">
      <button class="back-btn" onclick="history.back()">←</button>
      <div class="info">
        <h3>Blok ${esc(iuranDetailBlok)}</h3>
        <small>${esc(bulanLabel)} • ${info.verified}/${info.total} bayar</small>
      </div>
      <div class="spacer"></div>
    </div>
  `;

  if (!warga.length) {
    html += '<div class="empty"><span class="icon">📭</span>Belum ada warga di blok ini</div>';
  } else {
    html += warga.map(w => {
      const s = w.status_bayar;
      const badgeCls = s === 'VERIFIED' ? 'verified' : (s === 'PENDING' ? 'pending' : 'rejected');
      const badgeTxt = s === 'VERIFIED' ? 'Lunas' : (s === 'PENDING' ? 'Pending' : 'Belum Bayar');
      const rumah = w.no_rumah ? 'No ' + esc(w.no_rumah) : '-';

      return `
        <div class="list-item">
          <div class="left">
            <div class="title">${esc(w.nama)}</div>
            <div class="sub">Blok ${esc(w.blok)} ${rumah} • ${esc(w.phone)}</div>
            <div class="sub" style="margin-top:4px"><span class="badge ${badgeCls}">${badgeTxt}</span></div>
          </div>
          <div style="text-align:right">
            ${s === 'VERIFIED' ? '<div class="amount">' + rupiah(w.nominal) + '</div><div class="sub">' + tgl(w.tgl_bayar) + '</div>' : ''}
            ${isBendahara() && s === 'BELUM' ? `
              <button class="btn primary sm" onclick="quickBayar('${esc(w.phone)}','${esc(w.nama)}')">+ Bayar</button>
            ` : ''}
            ${isBendahara() && s === 'PENDING' && w.iuran_id ? `
              <div class="btn-row" style="margin-top:6px">
                <button class="btn success sm" onclick="approveIuranDetail('${esc(w.iuran_id)}')">✓</button>
                <button class="btn danger sm" onclick="rejectIuranDetail('${esc(w.iuran_id)}')">✕</button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  area.innerHTML = html;
}

function backToRingkasan(silent){
  silent = silent || false;
  iuranView = 'RINGKASAN';
  iuranDetailBlok = null;
  renderIuranHTML();
  if (!silent) silentPop();
  else reArmBackGuard();   // ← TAMBAH
}

function quickBayar(phone, nama){
  // Langsung buka form dengan warga sudah terpilih
  formBayarIuran(phone);
}

// approveIuran & rejectIuran — DIALOG MODERN
async function approveIuran(id){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Verifikasi pembayaran ini?', {
      title: 'Verifikasi Iuran', icon: '✓', type: 'success',
      okText: 'Verifikasi', cancelText: 'Batal'
    });
    if (!ok) return;

    showLoading(true);
    const res = await api('verifyIuran', session.token, id, 'approve', '');
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidateKeuangan();
    toast('Terverifikasi', 'success');
    renderIuran(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

async function rejectIuran(id){
  if (!acquireSubmitLock()) return;
  try {
    const note = await promptDialog('Alasan penolakan:', '', {
      title: 'Tolak Iuran', icon: '✕', type: 'danger',
      okText: 'Tolak', placeholder: 'Contoh: Bukti transfer tidak jelas'
    });
    if (note === null) return;

    showLoading(true);
    const res = await api('verifyIuran', session.token, id, 'reject', note);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidateKeuangan();
    toast('Ditolak', 'success');
    renderIuran(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

async function approveIuranDetail(id){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Verifikasi pembayaran ini?', {
      title: 'Verifikasi Iuran', icon: '✓', type: 'success', okText: 'Verifikasi'
    });
    if (!ok) return;

    showLoading(true);
    const res = await api('verifyIuran', session.token, id, 'approve', '');
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidateKeuangan();
    toast('Terverifikasi', 'success');
    renderIuran(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

async function rejectIuranDetail(id){
  if (!acquireSubmitLock()) return;
  try {
    const note = await promptDialog('Alasan penolakan:', '', {
      title: 'Tolak Iuran', icon: '✕', type: 'danger',
      okText: 'Tolak', placeholder: 'Contoh: Bukti transfer tidak jelas'
    });
    if (note === null) return;

    showLoading(true);
    const res = await api('verifyIuran', session.token, id, 'reject', note);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidateKeuangan();
    toast('Ditolak', 'success');
    renderIuran(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

function formatBulan(ym){
  if (!ym) return '-';
  const parts = ym.split('-');
  const y = parts[0], m = parts[1];
  const bulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return bulan[parseInt(m)-1] + ' ' + y;
}

// ============ FORM BAYAR IURAN ============
let wargaCache = null;
let selectedWarga = null;

// ===== WARGA CACHE dengan localStorage (TTL 1 jam) =====
function saveWargaCache(data) {
  try {
    localStorage.setItem('rtdigital_warga', JSON.stringify({
      data: data,
      ts: Date.now()
    }));
  } catch(e) {}
}

function loadWargaCache() {
  try {
    const v = localStorage.getItem('rtdigital_warga');
    if (!v) return null;
    const obj = JSON.parse(v);
    if (Date.now() - obj.ts > 60 * 60 * 1000) return null;  // TTL 1 jam
    return obj.data;
  } catch(e) { return null; }
}

function clearWargaCache() {
  try { localStorage.removeItem('rtdigital_warga'); } catch(e) {}
  wargaCache = null;
}

async function prefetchWargaCache() {
  if (!session.token) return;
  try {
    const res = await api('getAllWargaAktif', session.token);
    if (res && res.ok) {
      wargaCache = res.data || [];
      saveWargaCache(wargaCache);
    }
  } catch(e) { /* silent */ }
}

// ===== RT CACHE =====
let rtCache = null;

function saveRTCache(data) {
  try {
    localStorage.setItem('rtdigital_rt', JSON.stringify({
      data: data,
      ts: Date.now()
    }));
  } catch(e) {}
}

function loadRTCache() {
  try {
    const v = localStorage.getItem('rtdigital_rt');
    if (!v) return null;
    const obj = JSON.parse(v);
    if (Date.now() - obj.ts > 24 * 60 * 60 * 1000) return null;  // TTL 24 jam (RT jarang berubah)
    return obj.data;
  } catch(e) { return null; }
}

function clearRTCache() {
  try { localStorage.removeItem('rtdigital_rt'); } catch(e) {}
  rtCache = null;
}

async function prefetchRTCache() {
  if (!session.token) return;
  try {
    const res = await api('listRT', session.token);
    if (res && res.ok) {
      rtCache = res.data || [];
      saveRTCache(rtCache);
    }
  } catch(e) { /* silent */ }
}

// ============ PREFETCH MENU UTAMA (PARALEL + PROGRESS) ============
let _prefetchingMenus = false;
let _pfTotal = 0;
let _pfDone = 0;

function pfSetProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const pctEl = document.querySelector('#prefetchBanner .pf-pct');
  const bar = document.getElementById('pfBar');
  if (pctEl) pctEl.textContent = pct + '%';
  if (bar) bar.style.width = pct + '%';
}

async function prefetchMenuUtama() {
  if (_prefetchingMenus || !session.token) return;
  _prefetchingMenus = true;

  const now = new Date();
  const bulanIni = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const isWarga = session.user.role === 'WARGA';
  const tasks = [];

  // 1) Home Dashboard
  if (!cache.home.data) {
    const apiFn = isWarga ? 'getWargaDashboard' : 'getDashboard';
    tasks.push(
      api(apiFn, session.token)
        .then(r => { if (r && r.ok) { cache.home.data = r.data; cache.home.dirty = false; } })
        .catch(e => console.warn('[Prefetch] Home:', e))
    );
  }

  // 2) Iuran bulan ini (khusus admin/bendahara)
  if (!isWarga) {
    const iuranKey = 'iuran_' + bulanIni;
    if (!cache[iuranKey] || !cache[iuranKey].data) {
      tasks.push(
        api('getRingkasanBlok', session.token, bulanIni)
          .then(r => { if (r && r.ok) { cache[iuranKey] = { data: r, dirty: false }; } })
          .catch(e => console.warn('[Prefetch] Iuran:', e))
      );
    }
  }

  // 3) Surat
  if (!cache.surat.data) {
    tasks.push(
      api('listSurat', session.token, {})
        .then(r => { if (r && r.ok) { cache.surat.data = r.data || []; cache.surat.dirty = false; } })
        .catch(e => console.warn('[Prefetch] Surat:', e))
    );
  }

  // 4) Data Warga (khusus admin/bendahara)
  if (!isWarga && !cache.users.data) {
    tasks.push(
      api('listUsers', session.token)
        .then(r => { if (r && r.ok) { cache.users.data = r.data || []; cache.users.dirty = false; } })
        .catch(e => console.warn('[Prefetch] Users:', e))
    );
  }

  // Kalau tidak ada task (semua cache fresh), tidak perlu banner
  if (!tasks.length) {
    _prefetchingMenus = false;
    return;
  }

  // ===== Setup progress =====
  _pfTotal = tasks.length;
  _pfDone = 0;

  const banner = document.getElementById('prefetchBanner');
  if (banner) banner.classList.remove('hidden');
  pfSetProgress(0, _pfTotal);

  // ===== Wrap tasks: increment counter setiap task selesai =====
  const wrappedTasks = tasks.map(p =>
    Promise.resolve(p)
      .then(r => {
        _pfDone++;
        pfSetProgress(_pfDone, _pfTotal);
        return r;
      })
      .catch(e => {
        _pfDone++;
        pfSetProgress(_pfDone, _pfTotal);
        return e;
      })
  );

  await Promise.allSettled(wrappedTasks);
  _prefetchingMenus = false;

  // ===== Biarkan user lihat 100% sebentar, lalu sembunyikan =====
  setTimeout(() => {
    if (banner) banner.classList.add('hidden');
  }, 500);

  console.log('[Prefetch] Menu utama selesai (' + _pfDone + '/' + _pfTotal + ')');
}

async function formBayarIuran(prefillPhone){
  // Coba pakai cache memory, fallback ke localStorage
  if (!wargaCache) wargaCache = loadWargaCache();

  selectedWarga = null;
  const now = new Date();
  const bulanIni = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const def = (cache.home.data && cache.home.data.iuranBulanan) || 50000;
  const isPrefill = !!prefillPhone;

  // ===== BUKA MODAL INSTAN =====
  openModal('Catat Pembayaran Iuran', `
    <div class="field" ${isPrefill ? 'style="display:none"' : ''}>
      <label>Nama Kepala Keluarga *</label>
      <div class="search-wrap" id="searchWrap">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input type="text" class="search-input" id="wargaSearch"
              placeholder="Cari nama atau blok..." autocomplete="off">
        <button class="search-clear" id="searchClear" type="button" aria-label="Clear">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
        <div class="search-list" id="searchList">
          ${!wargaCache ? '<div class="search-empty">⏳ Memuat data warga...</div>' : ''}
        </div>
      </div>
      <div id="selectedContainer"></div>
    </div>

    <div id="selectedContainerPrefill"></div>

    <div class="field">
      <label>Blok Rumah</label>
      <input type="text" id="fBlok" readonly placeholder="Akan terisi otomatis"
             style="background:#f5f7fa;color:#666">
    </div>

    <div class="field"><label>Jenis Iuran</label>
      <select id="fJenis">
        <option value="BULANAN">Iuran Bulanan</option>
        <option value="SANTUNAN">Santunan (Sakit/Duka)</option>
        <option value="KEMATIAN">Uang Kematian</option>
        <option value="LAINNYA">Lainnya</option>
      </select></div>

    <div class="field"><label>Periode (YYYY-MM)</label>
      <input type="month" id="fPeriode" value="${bulanIni}"></div>

    <div class="field"><label>Nominal (Rp)</label>
      <input type="number" id="fNominal" value="${def}" step="1000"></div>

    <div class="field"><label>Metode</label>
      <select id="fMetode">
        <option value="CASH">Tunai / Cash</option>
        <option value="TF">Transfer Bank</option>
      </select></div>

    <div class="field"><label>Catatan</label>
      <input type="text" id="fCatatan" placeholder="Opsional"></div>

    <button class="btn primary block" onclick="submitIuran()">Simpan</button>
  `);

  setupWargaSearch();

  // ===== Kalau PREFILL: pastikan cache ada, lalu auto-pilih =====
  if (isPrefill) {
    if (!wargaCache) {
      try {
        const res = await api('getAllWargaAktif', session.token);
        if (res && res.ok) {
          wargaCache = res.data || [];
          saveWargaCache(wargaCache);
        }
      } catch(e) { /* silent */ }
    }

    if (wargaCache) {
      const w = wargaCache.find(x => x.phone === prefillPhone);
      if (w) {
        // Set selectedWarga
        selectedWarga = w;
        const blokDisplay = w.blok && w.no_rumah
          ? 'Blok ' + w.blok + ' No ' + w.no_rumah
          : (w.blok ? 'Blok ' + w.blok : '-');

        // Isi blok
        const fBlok = $('#fBlok');
        if (fBlok) fBlok.value = blokDisplay;

        // Tampilkan chip di container prefill
        const cont = $('#selectedContainerPrefill');
        if (cont) {
          cont.innerHTML = `
            <div class="selected-chip">
              <div class="chip-icon">👤</div>
              <div class="chip-info">
                <b>${esc(w.nama)}</b>
                <small>${esc(blokDisplay)} • ${esc(w.phone)}</small>
              </div>
              <button class="chip-remove" type="button"
                onclick="gantiWargaPrefill('${esc(w.phone)}')"
                title="Ganti warga">✕</button>
            </div>
          `;
        }

        // Fokus ke nominal setelah modal render
        setTimeout(() => {
          const nom = $('#fNominal');
          if (nom) { nom.focus(); nom.select(); }
        }, 200);
      }
    }
    return;
  }

  // ===== TANPA PREFILL: load warga di background =====
  if (!wargaCache) {
    try {
      const res = await api('getAllWargaAktif', session.token);
      if (res && res.ok) {
        wargaCache = res.data || [];
        saveWargaCache(wargaCache);

        const list = $('#searchList');
        if (list && list.innerHTML.indexOf('Memuat') >= 0) {
          list.innerHTML = '';
          list.classList.remove('open');
        }
      } else {
        const list = $('#searchList');
        if (list) list.innerHTML = '<div class="search-empty">Gagal memuat: ' + esc(res && res.msg || 'error') + '</div>';
      }
    } catch(e) {
      const list = $('#searchList');
      if (list) list.innerHTML = '<div class="search-empty">Gagal: ' + esc(e.message) + '</div>';
    }
  }
}

function setupWargaSearch(){
  const input = $('#wargaSearch');
  const list = $('#searchList');
  const wrap = $('#searchWrap');
  const clear = $('#searchClear');
  if (!input || !list || !wrap || !clear) return;

  const render = (q) => {
    q = (q || '').toLowerCase().trim();
    let items = wargaCache || [];

    if (q.length >= 1) {
      items = items.filter(w => {
        const hay = (w.nama + ' ' + w.blok + ' ' + w.no_rumah + ' ' + w.phone + ' ' + (w.nik||'')).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    } else {
      items = items.slice(0, 20);
    }

    if (!items.length) {
      list.innerHTML = '<div class="search-empty">Tidak ditemukan</div>';
    } else {
      list.innerHTML = items.slice(0, 50).map(w =>
        '<div class="search-item" data-phone="' + esc(w.phone) + '">' +
          '<span class="si-name">' + esc(w.nama) + '</span>' +
          '<span class="si-blok">' + esc(w.blok) + '-' + esc(w.no_rumah) + '</span>' +
        '</div>'
      ).join('');
    }

    list.classList.add('open');
    $$('.search-item', list).forEach(el => {
      el.onclick = () => {
        const phone = el.dataset.phone;
        const w = wargaCache.find(x => x.phone === phone);
        if (w) selectWarga(w);
      };
    });
  };

  input.onfocus = () => render(input.value);
  input.oninput = () => {
    wrap.classList.toggle('has-value', !!input.value);
    render(input.value);
  };
  clear.onclick = () => {
    input.value = '';
    wrap.classList.remove('has-value');
    list.classList.remove('open');
    selectedWarga = null;
    const cont = $('#selectedContainer');
    if (cont) cont.innerHTML = '';
    const fb = $('#fBlok');
    if (fb) fb.value = '';
  };

  setTimeout(() => input.focus(), 100);
}

function selectWarga(w){
  selectedWarga = w;
  const blokDisplay = w.blok && w.no_rumah
    ? 'Blok ' + w.blok + ' No ' + w.no_rumah
    : (w.blok ? 'Blok ' + w.blok : '-');

  // Set #fBlok kalau ada (form iuran)
  const fBlok = $('#fBlok');
  if (fBlok) fBlok.value = blokDisplay;

  // Reset field search
  const wSearch = $('#wargaSearch');
  if (wSearch) {
    wSearch.value = '';
    const wrap = wSearch.closest('.search-wrap');
    if (wrap) wrap.classList.remove('has-value');
  }

  const list = $('#searchList');
  if (list) list.classList.remove('open');

  // Render chip — deteksi container mana yang ada
  const chipHTML = `
    <div class="selected-chip">
      <div class="chip-icon">👤</div>
      <div class="chip-info">
        <b>${esc(w.nama)}</b>
        <small>${esc(blokDisplay)} • ${esc(w.phone)}</small>
      </div>
      <button class="chip-remove" onclick="clearSelectedWarga()" type="button">✕</button>
    </div>
  `;

  // Form kampanye
  const kpCont = $('#kpSelectedContainer');
  if (kpCont) {
    kpCont.innerHTML = chipHTML;
    return;
  }

  // Form iuran (default)
  const cont = $('#selectedContainer');
  if (cont) cont.innerHTML = chipHTML;
}

function clearSelectedWarga(){
  selectedWarga = null;

  // Bersihkan chip di kedua container
  const cont = $('#selectedContainer');
  if (cont) cont.innerHTML = '';

  const kpCont = $('#kpSelectedContainer');
  if (kpCont) {
    kpCont.innerHTML = '';
    // Munculkan kembali field search kalau form kampanye
    const field = $('#kpSearchField');
    if (field) field.style.display = '';
  }

  const fBlok = $('#fBlok');
  if (fBlok) fBlok.value = '';

  const ws = $('#wargaSearch');
  if (ws) {
    ws.focus();
    // Trigger open list untuk user langsung pilih
    if (ws.onfocus) ws.onfocus();
  }
}

function gantiWargaPrefill(phone){
  // Munculkan kembali field search & hapus chip
  selectedWarga = null;

  const searchField = document.querySelector('.field[style*="display:none"]');
  if (searchField) searchField.style.display = '';

  const cont = $('#selectedContainerPrefill');
  if (cont) cont.innerHTML = '';

  const fBlok = $('#fBlok');
  if (fBlok) fBlok.value = '';

  const ws = $('#wargaSearch');
  if (ws) {
    ws.focus();
    // Trigger open list
    if (ws.onfocus) ws.onfocus();
  }
}

async function submitIuran(){
  if (!acquireSubmitLock()) return;
  try {
    if (session.user.role === 'WARGA') {
      return toast('Hanya admin/bendahara yang dapat mencatat iuran', 'error');
    }
    if (!selectedWarga) return toast('Pilih Kepala Keluarga dulu', 'error');

    const payload = {
      phone: selectedWarga.phone,
      jenis: $('#fJenis').value,
      periode: $('#fPeriode').value,
      nominal: Number($('#fNominal').value),
      metode: $('#fMetode').value,
      catatan: ($('#fCatatan') && $('#fCatatan').value) || '',
      tgl_bayar: new Date().toISOString()
    };

    // Validasi lokal dulu
    if (!payload.nominal || payload.nominal <= 0) {
      return toast('Nominal tidak valid', 'error');
    }

    // ===== TAMPILKAN PROCESS DIALOG =====
    showProcess('Menyimpan iuran...', 'Mohon tunggu, sedang memproses pembayaran');

    let res;
    try {
      res = await api('submitIuran', session.token, payload);
    } catch (err) {
      processError('Gagal terhubung', 'Periksa koneksi internet Anda');
      await sleep(1800);
      hideProcess();
      return;
    }

    // ===== CEK HASIL =====
    if (!res || !res.ok) {
      processError('Gagal menyimpan', (res && res.msg) || 'Terjadi kesalahan tidak dikenal');
      await sleep(2000);
      hideProcess();
      return;
    }

    // ===== SUKSES =====
    processSuccess(
      'Iuran tersimpan!',
      payload.nominal.toLocaleString('id-ID') === '0'
        ? ''
        : 'Rp ' + payload.nominal.toLocaleString('id-ID') + ' • ' + selectedWarga.nama
    );

    await sleep(1200);   // biar user lihat centang hijau
    hideProcess();

    // ===== REFRESH UI =====
    closeModal(true);
    invalidateKeuangan();
    toast('Iuran tercatat untuk ' + selectedWarga.nama, 'success');
    clearWargaCache();

    if (currentPage === 'iuran') {
      renderIuran(true);
    } else {
      renderHome(true);
    }
  } catch(e) {
    hideProcess();
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ SHOW PENDING (dari Home) ============
function showPendingIuran(){
  const now = new Date();
  iuranFilter.bulan = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  iuranFilter.status = 'PENDING';
  iuranFilter.blok = 'ALL';
  iuranMode = 'DAFTAR';
  iuranView = 'RINGKASAN';
  iuranDetailBlok = null;
  invalidate('iuran_' + iuranFilter.bulan);
  navigate('iuran', true);
}

// ============ PENGELUARAN ============
function formPengeluaran(){
  openModal('Catat Pengeluaran', `
    <div class="field"><label>Tanggal</label>
      <input type="date" id="pTanggal" value="${new Date().toISOString().substring(0,10)}"></div>
    <div class="field"><label>Kategori</label>
      <select id="pKategori">
        <option value="OPERASIONAL">Operasional</option>
        <option value="KEAMANAN">Keamanan</option>
        <option value="KEBERSIHAN">Kebersihan</option>
        <option value="SOSIAL">Sosial / Santunan</option>
        <option value="PEMBANGUNAN">Pembangunan</option>
        <option value="LAINNYA">Lainnya</option>
      </select></div>
    <div class="field"><label>Keterangan</label>
      <textarea id="pKet" placeholder="Contoh: Bayar honor ronda bulan Oktober"></textarea></div>
    <div class="field"><label>Nominal (Rp)</label>
      <input type="number" id="pNominal" step="1000" placeholder="0"></div>
    <button class="btn primary block" onclick="submitPengeluaran()">Simpan</button>
  `);
}

async function submitPengeluaran(){
  if (!acquireSubmitLock()) return;
  try {
    const payload = {
      tanggal: $('#pTanggal').value,
      kategori: $('#pKategori').value,
      keterangan: $('#pKet').value,
      nominal: Number($('#pNominal').value)
    };

    // Validasi lokal dulu
    if (!payload.keterangan || !payload.keterangan.trim()) {
      return toast('Keterangan wajib diisi', 'error');
    }
    if (!payload.nominal || payload.nominal <= 0) {
      return toast('Nominal tidak valid', 'error');
    }

    // ===== TAMPILKAN PROCESS DIALOG =====
    showProcess('Menyimpan pengeluaran...', 'Mohon tunggu, sedang mencatat pengeluaran');

    let res;
    try {
      res = await api('submitPengeluaran', session.token, payload);
    } catch (err) {
      processError('Gagal terhubung', 'Periksa koneksi internet Anda');
      await sleep(1800);
      hideProcess();
      return;
    }

    // ===== CEK HASIL =====
    if (!res || !res.ok) {
      processError('Gagal menyimpan', (res && res.msg) || 'Terjadi kesalahan tidak dikenal');
      await sleep(2000);
      hideProcess();
      return;
    }

    // ===== SUKSES =====
    processSuccess(
      'Pengeluaran tersimpan!',
      'Rp ' + payload.nominal.toLocaleString('id-ID') + ' • ' + payload.kategori
    );

    await sleep(1200);
    hideProcess();

    // ===== REFRESH UI =====
    closeModal(true);
    invalidateKeuangan();
    toast('Pengeluaran tercatat', 'success');
    renderHome(true);
  } catch(e) {
    hideProcess();
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ SURAT ============
async function renderSurat(force){
  force = force || false;
  const main = $('#mainContent');

  if (force || cache.surat.dirty || cache.surat.data === null){
    if (!cache.surat.data) main.innerHTML = skeleton();
    try{
      const res = await api('listSurat', session.token, {});
      if (!res.ok) return toast(res.msg,'error');
      cache.surat.data = res.data || [];
      cache.surat.dirty = false;
    }catch(e){ return toast('Gagal: '+e.message,'error'); }
  }

  renderSuratHTML();
}

function renderSuratHTML(){
  const main = $('#mainContent');
  const all = cache.surat.data || [];
  const items = suratFilter === 'ALL' ? all : all.filter(x => x.status === suratFilter);
  const isAdm = isSekretaris();
  const labels = { ALL:'Semua', DIAJUKAN:'Diajukan', DIPROSES:'Diproses', SELESAI:'Selesai', DITOLAK:'Ditolak' };

  main.innerHTML = `
    <div class="tabs">
      ${['ALL','DIAJUKAN','DIPROSES','SELESAI','DITOLAK'].map(f =>
        '<button class="tab ' + (suratFilter===f?'active':'') + '" data-filter="' + f + '">' + labels[f] + '</button>'
      ).join('')}
    </div>

    <div>
      ${items.length === 0
        ? '<div class="empty"><span class="icon">📭</span>Belum ada pengajuan surat</div>'
        : items.map(s => {
          const hasFile = !!(s.file_url && s.file_url.length > 0);

          return `
            <div class="list-item">
              <div class="left">
                <div class="title">${esc(s.jenis)}</div>
                ${s.nama || isAdm ? '<div class="sub">👤 ' + esc(s.nama || s.phone) + '</div>' : ''}
                <div class="sub">${s.no_surat?'No: '+esc(s.no_surat)+' • ':''}${tgl(s.tgl_ajuan)}</div>
                <div class="sub">${esc(s.keperluan)}</div>
                <div class="sub" style="margin-top:4px">${badge(s.status)}</div>
                ${s.catatan ? '<div class="sub" style="margin-top:4px;color:var(--warn)">📝 ' + esc(s.catatan) + '</div>' : ''}
              </div>
              <div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                ${hasFile ? `
                  <button class="btn-download" onclick="downloadSurat('${esc(s.id)}')">📥 Download</button>
                ` : ''}
                ${isAdm ? '<button class="icon-btn" style="color:#1976D2" data-kelola="' + esc(s.id) + '">⚙</button>' : ''}
              </div>
            </div>
          `;
        }).join('')}
    </div>
  `;

  $$('.tab', main).forEach(b => {
    b.onclick = () => {
      if (suratFilter === b.dataset.filter) return;
      suratFilter = b.dataset.filter;
      renderSuratHTML();
    };
  });

  $$('button[data-kelola]', main).forEach(b => b.onclick = () => formKelolaSurat(b.dataset.kelola));

  const fab = document.createElement('button');
  fab.className = 'fab'; fab.textContent = '+';
  fab.onclick = formAjukanSurat;
  main.appendChild(fab);
}

function formAjukanSurat(){
  openModal('Ajukan Surat', `
    <div class="field"><label>Jenis Surat</label>
      <select id="sJenis">
        <option>Surat Keterangan Domisili</option>
        <option>Surat Keterangan Tidak Mampu (SKTM)</option>
        <option>Surat Pengantar RT/RW</option>
        <option>Surat Keterangan Usaha</option>
        <option>Surat Keterangan Kelahiran</option>
        <option>Surat Keterangan Kematian</option>
        <option>Surat Pengantar Pindah</option>
        <option>Surat Keterangan Kehilangan</option>
        <option>Lainnya</option>
      </select></div>
    <div class="field"><label>Keperluan</label>
      <textarea id="sKeperluan" placeholder="Contoh: Untuk keperluan pendaftaran sekolah anak"></textarea></div>
    <button class="btn primary block" onclick="submitSurat()">Ajukan</button>
  `);
}

async function submitSurat(){
  if (!acquireSubmitLock()) return;
  try {
    const payload = { jenis: $('#sJenis').value, keperluan: $('#sKeperluan').value };
    if (!payload.keperluan.trim()) return toast('Keperluan wajib diisi','error');
    showLoading(true);
    const res = await api('submitSurat', session.token, payload);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    closeModal();
    invalidate('home','surat');
    toast('Pengajuan terkirim', 'success');
    renderSurat(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

async function formKelolaSurat(id){
  const s = (cache.surat.data || []).find(x => x.id === id);
  if (!s) return toast('Data tidak ditemukan','error');

  const status = String(s.status || '').toUpperCase();
  const hasFile = !!(s.file_url && s.file_url.length > 0);

  let infoHTML = `
    <div class="card" style="box-shadow:none;background:#f7f9fc;margin-bottom:14px">
      <div class="row"><span class="label">Pemohon</span><span class="value">${esc(s.nama || s.phone)}</span></div>
      <div class="row"><span class="label">No. HP</span><span class="value">${esc(s.phone)}</span></div>
      <div class="row"><span class="label">Jenis</span><span class="value">${esc(s.jenis)}</span></div>
      <div class="row"><span class="label">Keperluan</span><span class="value">${esc(s.keperluan)}</span></div>
      <div class="row"><span class="label">No. Surat</span><span class="value">${esc(s.no_surat||'-')}</span></div>
      <div class="row"><span class="label">Status</span><span class="value">${badge(s.status)}</span></div>
      ${hasFile ? '<div class="row"><span class="label">File</span><span class="value" style="color:var(--success)">✓ ' + esc(s.file_name||'terlampir') + '</span></div>' : ''}
    </div>
  `;

  let fileHTML = '';
  if (hasFile) {
    const isImg = /\.(jpg|jpeg|png)$/i.test(s.file_name || '');
    fileHTML += `
      <div class="file-chip">
        <div class="fi-icon ${isImg?'img':''}">${isImg ? '🖼' : 'PDF'}</div>
        <div class="fi-info">
          <div class="fi-name">${esc(s.file_name || 'file-surat')}</div>
          <div class="fi-size">Sudah di-upload</div>
        </div>
        <a href="${esc(s.file_url)}" target="_blank" rel="noopener" class="fi-remove" style="color:var(--primary);text-decoration:none;font-size:16px" title="Download">📥</a>
        <button class="fi-remove" onclick="hapusFileSurat('${esc(s.id)}')" title="Hapus">🗑</button>
      </div>
    `;
  }

  let uploadHTML = '';
  if (status === 'DIAJUKAN') {
    uploadHTML = `
      <div class="card" style="background:var(--warn-light);box-shadow:none;padding:12px;margin-bottom:12px">
        <div style="font-size:12px;color:var(--warn);font-weight:600">
          ⚠️ Tandai "Diproses" dulu untuk generate nomor surat sebelum upload
        </div>
      </div>
    `;
  } else if (status === 'DITOLAK') {
    uploadHTML = `
      <div class="card" style="background:var(--danger-light);box-shadow:none;padding:12px;margin-bottom:12px">
        <div style="font-size:12px;color:var(--danger);font-weight:600">
          ✗ Surat sudah ditolak. Tidak bisa upload.
        </div>
      </div>
    `;
  } else {
    uploadHTML = `
      <div class="field">
        <label>${hasFile ? 'Ganti File Surat' : 'Upload Surat Final'}</label>
        <input type="file" id="suratFileInput" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" style="display:none">
        <div class="upload-area" id="uploadArea" onclick="document.getElementById('suratFileInput').click()">
          <span class="upload-icon">📤</span>
          <div class="upload-title">Pilih File Surat</div>
          <div class="upload-sub">PDF, JPG, PNG • Max 5 MB</div>
        </div>
        <div id="uploadPreview"></div>
        <div class="upload-progress" id="uploadProgress">
          <div class="upload-progress-bar" id="uploadProgressBar"></div>
        </div>
      </div>
    `;
  }

  let actionHTML = '';
  if (status === 'DIAJUKAN') {
    actionHTML = `
      <button class="btn primary block" onclick="updateSurat('${id}','DIPROSES')">✔ Tandai Diproses (Generate No. Surat)</button>
      <button class="btn danger block" style="margin-top:8px" onclick="updateSurat('${id}','DITOLAK')">✗ Tolak</button>
    `;
  } else if (status === 'DIPROSES') {
    actionHTML = `
      <button class="btn primary block" onclick="submitUploadSurat('${id}')">📤 Upload & Selesaikan Surat</button>
      <button class="btn danger block" style="margin-top:8px" onclick="updateSurat('${id}','DITOLAK')">✗ Tolak</button>
    `;
  } else if (status === 'SELESAI') {
    actionHTML = `
      <button class="btn primary block" onclick="submitUploadSurat('${id}')">📤 Ganti File Surat</button>
    `;
  }

  openModal('Kelola Surat', `
    ${infoHTML}
    ${fileHTML}
    ${uploadHTML}
    <div class="field"><label>Catatan untuk warga (opsional)</label>
      <textarea id="sCatatan" placeholder="Contoh: Silakan ambil hardcopy di rumah Pak RT">${esc(s.catatan||'')}</textarea></div>
    ${actionHTML}
  `);

  const fileInput = $('#suratFileInput');
  if (fileInput) {
    fileInput.onchange = function() {
      const f = this.files && this.files[0];
      if (!f) return;

      const MAX = 5 * 1024 * 1024;
      if (f.size > MAX) {
        toast('File terlalu besar. Max 5 MB.', 'error');
        this.value = '';
        return;
      }
      const allowed = ['application/pdf','image/jpeg','image/jpg','image/png'];
      if (allowed.indexOf(f.type) < 0) {
        toast('Format harus PDF, JPG, atau PNG', 'error');
        this.value = '';
        return;
      }

      window._suratPendingFile = f;

      const sizeKB = Math.round(f.size / 1024);
      const isImg = f.type.indexOf('image/') === 0;
      $('#uploadPreview').innerHTML = `
        <div class="file-chip">
          <div class="fi-icon ${isImg?'img':''}">${isImg ? '🖼' : 'PDF'}</div>
          <div class="fi-info">
            <div class="fi-name">${esc(f.name)}</div>
            <div class="fi-size">${sizeKB} KB • siap di-upload</div>
          </div>
          <button class="fi-remove" type="button" onclick="clearPendingFile()">✕</button>
        </div>
      `;
      $('#uploadArea').classList.add('has-file');
    };
  }
}

function clearPendingFile(){
  window._suratPendingFile = null;
  const fi = $('#suratFileInput');
  if (fi) fi.value = '';
  const up = $('#uploadPreview');
  if (up) up.innerHTML = '';
  const area = $('#uploadArea');
  if (area) area.classList.remove('has-file');
}

async function updateSurat(id, status){
  if (!acquireSubmitLock()) return;
  try {
    const catatan = ($('#sCatatan') && $('#sCatatan').value) || '';
    showLoading(true);
    const res = await api('updateSuratStatus', session.token, id, status, catatan);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    closeModal();
    invalidate('home','surat');
    toast('Status: ' + status + (res.no_surat ? ' • No: ' + res.no_surat : ''), 'success');
    renderSurat(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ CACHE KELUARGA (TTL 10 menit) ============
let keluargaCache = { data: null, ts: 0, phone: null };
const KELUARGA_TTL = 10 * 60 * 1000;

function invalidateKeluargaCache() {
  keluargaCache = { data: null, ts: 0, phone: null };
}

async function renderProfil(){
  const u = session.user;
  const main = $('#mainContent');
  const isBend = isBendahara();

  main.innerHTML = `
    <div class="card" style="text-align:center">
      <div style="font-size:64px;line-height:1">👤</div>
      <h3 style="margin-top:8px">${esc(u.nama)}</h3>
      <p style="color:#888;font-size:13px">${esc(u.phone)} • ${esc(u.role)}</p>
      <p style="color:#888;font-size:12px;margin-top:4px">${esc(u.rt_id)}</p>
      ${u.blok ? '<p style="color:var(--primary);font-size:12px;margin-top:4px;font-weight:600">Blok ' + esc(u.blok) + (u.no_rumah?' No '+esc(u.no_rumah):'') + '</p>' : ''}
    </div>

    <div class="card">
      <div class="row"><span class="label">No. KK</span><span class="value">${esc(u.no_kk||'-')}</span></div>
      <div class="row"><span class="label">NIK</span><span class="value">${esc(u.nik||'-')}</span></div>
      <div class="row"><span class="label">Alamat</span><span class="value">${esc(u.alamat||'-')}</span></div>
      <div class="row"><span class="label">Email</span><span class="value">${esc(u.email||'-')}</span></div>
    </div>

    <div class="section-title">Keluarga Saya</div>
    <div class="card" id="keluargaContainer" style="padding:14px">
      <div style="text-align:center;color:#888;font-size:12px">⏳ Memuat anggota keluarga...</div>
    </div>

    <div class="section-title">Keamanan</div>
    <div class="card" style="padding:12px">
      <button class="btn outline block" onclick="formGantiPwd()">🔒 Ganti Password</button>
    </div>

    ${isBend ? `
      <div class="section-title">Manajemen Warga</div>
      <div class="card" style="padding:12px">
        <button class="btn outline block" onclick="navigate('warga')">👥 Kelola Data Warga</button>
      </div>` : ''}

    <div class="section-title">Lainnya</div>
    <div class="card" style="padding:12px">
      <button class="btn danger block" onclick="doLogout()">Keluar</button>
    </div>
    <p style="text-align:center;color:#aaa;font-size:11px;margin:20px 0">RT Digital v1.3</p>
  `;

  // ===== Cek cache KeluargaSaya =====
  const now = Date.now();
  let keluargaRes;

  if (keluargaCache.data && keluargaCache.phone === u.phone && (now - keluargaCache.ts) < KELUARGA_TTL) {
    // Pakai cache
    keluargaRes = keluargaCache.data;
    renderKeluargaHTML(keluargaRes);
  } else {
    // Fetch dari server
    try {
      keluargaRes = await api('getKeluargaSaya', session.token);
      if (keluargaRes && keluargaRes.ok) {
        keluargaCache = { data: keluargaRes, ts: now, phone: u.phone };
      }
      renderKeluargaHTML(keluargaRes);
    } catch(e) {
      const cont = $('#keluargaContainer');
      if (cont) cont.innerHTML = '<div style="text-align:center;color:#888;font-size:12px;padding:8px">Gagal memuat: ' + esc(e.message) + '</div>';
    }
  }
}

function renderKeluargaHTML(res) {
  const cont = $('#keluargaContainer');
  if (!cont) return;

  if (!res.ok || !res.data || res.data.length === 0) {
    cont.innerHTML = '<div style="text-align:center;color:#888;font-size:12px;padding:8px">Belum ada data anggota keluarga<br><span style="font-size:11px">Hubungi admin untuk melengkapi data</span></div>';
    return;
  }

  const list = res.data;
  const headerInfo = '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border)">' +
    '<b style="color:var(--primary);font-size:13px">' + list.length + '</b> anggota keluarga terdaftar' +
  '</div>';

  cont.innerHTML = headerInfo + list.map(a => {
    const initial = (a.nama || '?').charAt(0).toUpperCase();
    const jk = String(a.jk || '').toUpperCase();
    const hub = String(a.hubungan || 'Lainnya');
    let bgColor = '#607D8B';
    if (hub === 'Kepala Keluarga') { bgColor = '#1976D2'; }
    else if (hub === 'Istri' || hub === 'Suami') { bgColor = '#E91E63'; }
    else if (hub === 'Anak') { bgColor = jk === 'P' ? '#FF9800' : '#00BCD4'; }
    else if (hub === 'Orang Tua') { bgColor = '#9E9E9E'; }

    const status = String(a.status_kk || 'AKTIF').toUpperCase();
    const tglTxt = a.tgl_lahir ? tgl(a.tgl_lahir) : '';
    const detail = [hub, jk === 'P' ? 'Perempuan' : 'Laki-laki', tglTxt].filter(Boolean).join(' • ');

    return `
      <div class="keluarga-item">
        <div class="a-icon" style="background:${bgColor}">${esc(initial)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${esc(a.nama)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(detail)}</div>
          ${a.nik ? '<div style="font-size:10px;color:#aaa;margin-top:1px">NIK: ' + esc(a.nik) + '</div>' : ''}
        </div>
        <span class="a-status ${status.toLowerCase()}" style="font-size:9px;padding:2px 6px;border-radius:8px;font-weight:700;text-transform:uppercase">${esc(status)}</span>
      </div>
    `;
  }).join('');
}

function formGantiPwd(){
  openModal('Ganti Password', `
    <div class="field"><label>Password Lama</label><input type="password" id="gOld"></div>
    <div class="field"><label>Password Baru</label><input type="password" id="gNew"></div>
    <div class="field"><label>Konfirmasi Password Baru</label><input type="password" id="gNew2"></div>
    <button class="btn primary block" onclick="submitGantiPwd()">Simpan</button>
  `);
}

async function submitGantiPwd(){
  if (!acquireSubmitLock()) return;
  try {
    const o = $('#gOld').value, n = $('#gNew').value, n2 = $('#gNew2').value;
    if (!o || !n) return toast('Lengkapi form','error');
    if (n !== n2) return toast('Konfirmasi tidak cocok','error');
    if (n.length < 6) return toast('Minimal 6 karakter','error');
    showLoading(true);
    const res = await api('changePassword', session.token, o, n);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    closeModal();
    toast('Password diubah', 'success');
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ FORM USER (Tambah/Edit Warga) ============
async function formUser(phone){
  // ===== Coba pakai cache dulu =====
  if (!rtCache) rtCache = loadRTCache();

  let u = { phone:'', nama:'', role:'WARGA', rt_id:session.user.rt_id, no_kk:'', alamat:'', email:'', status:'AKTIF', blok:'', no_rumah:'' };
  if (phone){
    const found = (cache.users.data || []).find(x => x.phone === phone);
    if (found) u = found;
  }

  const blokList = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P'];

  // Helper: bikin dropdown RT (dari cache kalau ada, atau minimal RT user sekarang)
  function buildRTOptions() {
    const rts = rtCache || [{ rt_id: session.user.rt_id, nama_rt: session.user.rt_id }];
    return rts.map(r => '<option value="' + esc(r.rt_id) + '" ' + (u.rt_id===r.rt_id?'selected':'') + '>' + esc(r.rt_id) + ' - ' + esc(r.nama_rt) + '</option>').join('');
  }

  // ===== BUKA MODAL INSTAN =====
  openModal(phone?'Edit Warga':'Tambah Warga', `
    <div class="field"><label>Nomor HP</label>
      <input type="tel" id="uPhone" value="${esc(u.phone)}" ${phone?'disabled':''} placeholder="08xxxxxxxxxx"></div>
    <div class="field"><label>Nama Lengkap *</label>
      <input type="text" id="uNama" value="${esc(u.nama)}" placeholder="Budi Santoso"></div>
    <div class="field"><label>NIK <span style="color:#999;font-weight:400">(opsional)</span></label>
      <input type="tel" id="uNik" value="${esc(u.nik || '')}" placeholder="3201234567890123" maxlength="20"></div>
    <div class="field"><label>Password ${phone?'(kosongkan jika tidak diubah)':''}</label>
      <input type="password" id="uPwd"></div>

    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1">
        <label>Blok</label>
        <select id="uBlok">
          <option value="">- pilih -</option>
          ${blokList.map(b => '<option ' + (u.blok===b?'selected':'') + '>' + b + '</option>').join('')}
        </select>
      </div>
      <div class="field" style="flex:1">
        <label>No. Rumah</label>
        <input type="text" id="uNoRumah" value="${esc(u.no_rumah||'')}" placeholder="12A">
      </div>
    </div>

    <div class="field"><label>Role</label>
      <select id="uRole">
        ${['WARGA','BENDAHARA','SEKRETARIS','ADMIN'].map(r =>
          '<option ' + (u.role===r?'selected':'') + '>' + r + '</option>').join('')}
      </select></div>

    <div class="field"><label>RT</label>
      <select id="uRt" data-loading="${rtCache ? '0' : '1'}">
        ${rtCache
          ? buildRTOptions()
          : '<option value="' + esc(u.rt_id) + '" selected>' + esc(u.rt_id) + ' • memuat...</option>'}
      </select></div>

    <div class="field"><label>No. KK</label><input type="text" id="uKk" value="${esc(u.no_kk||'')}"></div>
    <div class="field"><label>Alamat</label><input type="text" id="uAlamat" value="${esc(u.alamat||'')}"></div>
    <div class="field"><label>Email</label><input type="email" id="uEmail" value="${esc(u.email||'')}"></div>
    <div class="field"><label>Status</label>
      <select id="uStatus">
        <option ${u.status==='AKTIF'?'selected':''}>AKTIF</option>
        <option ${u.status==='NONAKTIF'?'selected':''}>NONAKTIF</option>
      </select></div>
    <button class="btn primary block" onclick="submitUser('${phone||''}')">Simpan</button>
  `);

  // ===== Kalau RT belum di-cache → load di background =====
  if (!rtCache) {
    try {
      const res = await api('listRT', session.token);
      if (res && res.ok) {
        rtCache = res.data || [];
        saveRTCache(rtCache);

        // Update dropdown RT kalau modal masih terbuka
        const selRt = $('#uRt');
        if (selRt) {
          selRt.innerHTML = buildRTOptions();
          selRt.setAttribute('data-loading', '0');
        }
      }
    } catch(e) { /* silent */ }
  }
}

async function submitUser(editPhone){
  if (!acquireSubmitLock()) return;
  try {
    const payload = {
      phone: $('#uPhone').value,
      nama: $('#uNama').value,
      nik: ($('#uNik') && $('#uNik').value.trim()) || '',
      password: $('#uPwd').value || undefined,
      role: $('#uRole').value,
      rt_id: $('#uRt').value,
      no_kk: $('#uKk').value,
      alamat: $('#uAlamat').value,
      email: $('#uEmail').value,
      status: $('#uStatus').value,
      blok: $('#uBlok').value,
      no_rumah: $('#uNoRumah').value
    };
    if (editPhone) payload.phone = editPhone;
    showLoading(true);
    const res = await api('saveUser', session.token, payload);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidate('home','users');
    clearWargaCache();
    invalidateKeluargaCache();
    toast(res.msg || 'Tersimpan','success');
    closeModal(true);
    if (currentPage === 'warga') {
      renderWarga(true);
    } else {
      renderHome(true);
    }
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

async function delUser(phone){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Hapus warga ini dari sistem?', {
      title: 'Hapus Warga', icon: '🗑', type: 'danger',
      okText: 'Hapus', cancelText: 'Batal'
    });
    if (!ok) return;

    showLoading(true);
    const res = await api('deleteUser', session.token, phone);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    invalidate('home','users');
    clearWargaCache();
    invalidateKeluargaCache();
    toast('Terhapus','success');
    if (currentPage === 'warga') renderWarga(true);
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {

  // ===== SERVICE WORKER REGISTRATION =====
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('[PWA] SW terdaftar:', reg.scope))
        .catch(err => console.log('[PWA] SW gagal:', err));
    });
  }

  // ===== DETEKSI TOUCH DEVICE =====
  const isTouch = ('ontouchstart' in window) ||
                  (navigator.maxTouchPoints > 0) ||
                  (navigator.msMaxTouchPoints > 0);
  if (isTouch) {
    document.body.classList.add('is-touch');
    document.body.style.display = 'block';
    document.body.style.padding = '0';
    document.body.style.background = 'var(--bg)';
  }

  // ===== GLOBAL OUTSIDE-CLICK: tutup search dropdown =====
  document.addEventListener('click', function(e) {
    const wrap = $('#searchWrap');
    if (!wrap) return;
    if (wrap.contains(e.target)) return;
    const list = $('#searchList');
    if (list) list.classList.remove('open');
  });

  // ===== NAV =====
  $$('.nav-btn').forEach(b => b.onclick = () => navigate(b.dataset.page));

  // ===== LOGIN =====
  $('#btnLogin').onclick = doLogin;
  $('#loginPwd').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });

  // ===== REFRESH (invalidate semua cache) =====
  $('#btnRefresh').onclick = () => {
    invalidateAll();
    if (iuranFilter.bulan) invalidate('iuran_' + iuranFilter.bulan);
    clearWargaCache();
    clearRTCache();
    invalidateKeluargaCache();
    navigate(currentPage, true);
    toast('Data diperbarui', 'success');
  };

  // ===== MODAL CLOSE =====
  $('#modalClose').onclick = () => closeModal();
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // ===== GLOBAL ERROR HANDLER =====
  window.addEventListener('error', e => {
    console.error('Global error:', e.error);
    const m = $('#mainContent');
    if (m && m.querySelector('.skeleton-card')) {
      m.innerHTML = '<div class="empty"><span class="icon">⚠️</span>' + esc(e.message) + '</div>';
    }
  });
  window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise:', e.reason);
    showLoading(false);
    toast('Error: ' + ((e.reason && e.reason.message) || e.reason), 'error');
  });

  // ===== AUTO-LOGIN + BOOT LOADER =====
  loadSession();

  function hideBootLoader(showLogin) {
    const bl = document.getElementById('bootLoader');
    if (bl) {
      bl.style.opacity = '0';
      setTimeout(() => { bl.remove(); }, 350);
    }
    if (showLogin) {
      const login = document.getElementById('loginScreen');
      if (login) login.classList.add('active');
    }
  }

  if (session.token && session.user){
    const apiFn = session.user.role === 'WARGA' ? 'getWargaDashboard' : 'getDashboard';
    api(apiFn).then(res => {
      if (res && res.ok){
        cache.home.data = res.data;
        cache.home.dirty = false;
        enterApp();
        startBackGuard();
        hideBootLoader(false);

        setTimeout(() => {
          if (['ADMIN','BENDAHARA','SEKRETARIS'].includes(session.user.role)) {
            prefetchWargaCache();
            prefetchRTCache();
          }
          prefetchMenuUtama();
        }, 500);
      } else {
        clearSession();
        hideBootLoader(true);
      }
    }).catch(() => {
      clearSession();
      hideBootLoader(true);
    });
  } else {
    hideBootLoader(true);
  }
});

// ============ BULK IMPORT UI ============
function bulkImportUI(){
  openModal('Import Warga Massal', `
    <div class="bulk-hint">
      <b>Cara pakai:</b><br>
      Copy dari Excel/Sheets → paste ke bawah.<br>
      <b>Format A (4 kolom):</b> <code>Nama | HP | Blok | No.Rumah</code><br>
      <b>Format B (5 kolom):</b> <code>Nama | NIK | HP | Blok | No.Rumah</code> ← <b>disarankan</b><br>
      Separator: <b>Tab</b> (paste Excel) atau <b>|</b> atau <b>,</b><br>
      <b>Contoh (tanpa NIK):</b><br>
      <code>Budi Santoso|081234567890|F|12A</code><br>
      <b>Contoh (dengan NIK):</b><br>
      <code>Budi Santoso|3201234567890123|081234567890|F|12A</code>
    </div>

    <div class="field">
      <label>Data Warga</label>
      <textarea id="bulkData" class="textarea-mono"
        placeholder="Budi Santoso|081234567890|F|12A&#10;Siti Aminah|081234567891|A|5"></textarea>
    </div>

    <div class="field">
      <label>Password Default</label>
      <input type="text" id="bulkPwd" value="warga123">
      <small style="color:#888;font-size:11px">Minimal 6 karakter. Warga bisa ganti nanti.</small>
    </div>

    <div id="bulkResult" style="margin-bottom:12px"></div>

    <button class="btn primary block" onclick="submitBulkImport()">Import Sekarang</button>
  `);
}

async function submitBulkImport(){
  if (!acquireSubmitLock()) return;
  try {
    const data = $('#bulkData').value.trim();
    const pwd = $('#bulkPwd').value.trim();
    if (!data) return toast('Data kosong','error');
    if (!pwd || pwd.length < 6) return toast('Password minimal 6 karakter','error');

    releaseSubmitLock(); // biar dialog konfirmasi bisa muncul
    const ok = await confirmDialog('Import data? Data dengan HP sama akan di-update.', {
      title: 'Import Warga',
      icon: '📥',
      type: 'warn',
      okText: 'Import',
      cancelText: 'Batal'
    });
    if (!ok) return;
    if (!acquireSubmitLock()) return;

    showLoading(true);
    const res = await api('bulkImportWarga', session.token, data, pwd);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');

    const s = res.summary;
    let resultHTML = `
      <div class="card" style="background:var(--success-light);box-shadow:none;padding:12px">
        <div style="font-weight:700;color:var(--success);margin-bottom:6px">✅ ${esc(res.msg)}</div>
        <div style="font-size:12px;line-height:1.8">
          • <b>${s.insert}</b> warga baru (password: <code>${esc(res.defaultPassword)}</code>)<br>
          • <b>${s.update}</b> warga di-update<br>
          • <b>${s.skip}</b> dilewati
        </div>
      </div>
    `;
    if (s.errors && s.errors.length) {
      resultHTML += `
        <div class="card" style="background:var(--danger-light);box-shadow:none;padding:12px">
          <div style="font-weight:700;color:var(--danger);font-size:12px;margin-bottom:6px">⚠️ Error (${s.errors.length}):</div>
          <div style="font-size:11px;max-height:120px;overflow-y:auto;font-family:monospace">
            ${s.errors.slice(0, 20).map(e => '• ' + esc(e)).join('<br>')}
            ${s.errors.length > 20 ? '<br>... dan ' + (s.errors.length-20) + ' lainnya' : ''}
          </div>
        </div>
      `;
    }
    $('#bulkResult').innerHTML = resultHTML;
    $('#bulkData').value = '';

    invalidate('home','users');
    clearWargaCache();
    toast('Import selesai', 'success');
  } catch(e) {
    showLoading(false);
    toast('Error: ' + e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ HALAMAN WARGA (full page) ============
let wargaFilter = { blok: 'ALL', q: '' };
let expandedKK = null;
let anggotaCache = {};

async function renderWarga(force){
  force = force || false;
  const main = $('#mainContent');

  if (force || cache.users.dirty || !cache.users.data) {
    if (!cache.users.data) main.innerHTML = skeleton();
    try {
      const res = await api('listUsers', session.token);
      if (!res.ok) return toast(res.msg,'error');
      cache.users.data = res.data || [];
      cache.users.dirty = false;
    } catch(e) { return toast('Gagal: '+e.message,'error'); }
  }

  renderWargaHTML();
}

function renderWargaHTML(){
  const main = $('#mainContent');

  // Cek apakah shell sudah ada (kalau ada, tidak perlu render ulang shell)
  const shellExists = !!$('#wargaListContainer');

  if (!shellExists) {
    // ===== Render SHELL sekali =====
    const all = cache.users.data || [];
    const blokOptions = ['ALL'].concat(
      [...new Set(all.map(u => u.blok).filter(Boolean))].sort()
    );

    main.innerHTML = `
      <div class="page-app-bar">
        <div class="left-side">
          <button class="icon-btn" onclick="history.back()">←</button>
        </div>
        <div class="title">Data Warga</div>
        <div class="right-side">
          <button class="icon-btn" onclick="bulkImportUI()" title="Import">📥</button>
          <button class="icon-btn" onclick="formUser()" title="Tambah">+</button>
        </div>
      </div>

      <div class="warga-toolbar">
        <div class="row1">
          <div class="search-wrap">
            <svg class="search-icon" style="left:10px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>
            <input type="text" class="search-input" id="wargaPageSearch"
              placeholder="Cari nama, blok, HP..." value="${esc(wargaFilter.q)}">
          </div>
          <select id="wargaPageBlok">
            ${blokOptions.map(b => '<option value="' + esc(b) + '" ' + (wargaFilter.blok===b?'selected':'') + '>' + (b==='ALL'?'Semua':b) + '</option>').join('')}
          </select>
        </div>
      </div>

      <div class="warga-summary" id="wargaSummary"></div>
      <div id="wargaListContainer"></div>
    `;

    // Attach search handler (SEKALI saja per shell)
    const searchInput = $('#wargaPageSearch');
    let searchTimer = null;
    searchInput.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        wargaFilter.q = searchInput.value;
        renderWargaList();
      }, 250);
    };

    // Attach filter blok handler
    $('#wargaPageBlok').onchange = (e) => {
      wargaFilter.blok = e.target.value;
      renderWargaList();
    };
  }

  // Selalu update list & summary
  renderWargaList();
}

function renderWargaList(){
  const container = $('#wargaListContainer');
  if (!container) return;

  const all = cache.users.data || [];

  // ===== Filter =====
  const q = wargaFilter.q.toLowerCase().trim();
  let filtered = all;
  if (wargaFilter.blok !== 'ALL') {
    filtered = filtered.filter(u => u.blok === wargaFilter.blok);
  }
  if (q) {
    filtered = filtered.filter(u => {
      const hay = (u.nama + ' ' + (u.blok||'') + ' ' + (u.no_rumah||'') + ' ' + u.phone + ' ' + (u.no_kk||'') + ' ' + (u.nik||'')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // ===== Group per blok =====
  const groups = {};
  filtered.forEach(u => {
    const b = u.blok || 'TANPA BLOK';
    if (!groups[b]) groups[b] = [];
    groups[b].push(u);
  });

  const blokKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'TANPA BLOK') return 1;
    if (b === 'TANPA BLOK') return -1;
    return a.localeCompare(b);
  });

  let bodyHTML = '';
  if (blokKeys.length === 0) {
    bodyHTML = '<div class="empty-warga"><span class="icon">📭</span>Tidak ada warga ditemukan</div>';
  } else {
    blokKeys.forEach(b => {
      const arr = groups[b];
      bodyHTML += '<div class="kk-group">' +
        '<div class="kk-group-header">' +
          '<span>' + (b === 'TANPA BLOK' ? '⚠️ Tanpa Blok' : '🏠 Blok ' + b) + '</span>' +
          '<span class="badge-blok">' + arr.length + ' KK</span>' +
        '</div>';

      arr.forEach(u => {
        const initial = (u.nama || '?').trim().charAt(0).toUpperCase();
        const anggotaCount = u.anggota_count || 0;
        const isExpanded = expandedKK === u.phone;
        const rumahTxt = u.no_rumah ? 'No ' + esc(u.no_rumah) + ' • ' : '';
        const roleTag = u.role !== 'WARGA' ? ' • <b>' + esc(u.role) + '</b>' : '';

        bodyHTML += `
          <div class="kk-row ${isExpanded?'expanded':''}" data-kk="${esc(u.phone)}">
            <div class="kk-row-main">
              <div class="kk-avatar">${esc(initial)}</div>
              <div class="kk-info">
                <div class="name">${esc(u.nama)}</div>
                <div class="sub">${rumahTxt}${esc(u.phone)}${roleTag}</div>
                <div class="sub"><b>${anggotaCount}</b> anggota keluarga${u.no_kk?' • KK '+esc(u.no_kk):''}</div>
                ${u.nik ? '<div class="sub" style="color:#999">NIK: ' + esc(u.nik) + '</div>' : ''}
              </div>
              <div class="kk-arrow">▶</div>
            </div>
            <div class="kk-anggota-list" id="anggota-${esc(u.phone)}">
              ${isExpanded ? renderAnggotaHTML(u.phone) : '<div style="padding:10px;text-align:center;color:#888;font-size:12px">Memuat...</div>'}
            </div>
          </div>
        `;
      });

      bodyHTML += '</div>';
    });
  }

  container.innerHTML = bodyHTML;

  // ===== Update summary =====
  const totalKK = filtered.length;
  const totalJiwa = filtered.reduce((sum, u) => sum + (u.anggota_count || 0), 0) + totalKK;
  const sumEl = $('#wargaSummary');
  if (sumEl) {
    sumEl.innerHTML = '<b>' + totalKK + '</b> KK • <b>' + totalJiwa + '</b> jiwa' +
      (wargaFilter.blok !== 'ALL' ? ' • Blok ' + esc(wargaFilter.blok) : '');
  }

  // ===== Attach KK handlers =====
  $$('.kk-row').forEach(row => {
    const mainRow = row.querySelector('.kk-row-main');
    if (mainRow) mainRow.onclick = () => toggleKK(row.dataset.kk);
  });

  if (expandedKK) attachAnggotaHandlers(expandedKK);
}

function renderAnggotaHTML(phone){
  const list = anggotaCache[phone];

  if (list === undefined) {
    return '<div style="padding:14px;text-align:center;color:#888;font-size:12px">⏳ Memuat anggota...</div>';
  }

  if (list.length === 0) {
    return '<div style="padding:12px;text-align:center;color:#888;font-size:12px">Belum ada anggota terdaftar</div>' +
      '<button class="tambah-anggota-btn" data-add="' + esc(phone) + '">+ Tambah Anggota</button>';
  }

  return list.map(a => {
    const initial = (a.nama || '?').charAt(0).toUpperCase();
    const jk = String(a.jk || '').toUpperCase();
    const hub = String(a.hubungan || 'Lainnya');
    let iconCls = 'lain';
    if (hub === 'Kepala Keluarga') iconCls = 'kk';
    else if (hub === 'Istri' || hub === 'Suami') iconCls = 'istri';
    else if (hub === 'Anak') iconCls = jk === 'P' ? 'anak-p' : 'anak-l';
    else if (hub === 'Orang Tua') iconCls = 'orangtua';

    const status = String(a.status_kk || 'AKTIF').toUpperCase();
    const statusCls = status.toLowerCase();

    const tglTxt = a.tgl_lahir ? tgl(a.tgl_lahir) : '';
    const detail = [hub, jk === 'P' ? 'Perempuan' : 'Laki-laki', tglTxt].filter(Boolean).join(' • ');

    return `
      <div class="anggota-item">
        <div class="a-icon ${iconCls}">${esc(initial)}</div>
        <div class="a-info">
          <div class="a-name">${esc(a.nama)}</div>
          <div class="a-detail">${esc(detail)}${a.nik?' • NIK '+esc(a.nik):''}</div>
        </div>
        <span class="a-status ${statusCls}">${esc(status)}</span>
        <div class="anggota-actions">
          <button data-edit-anggota="${esc(a.id)}" data-kk-phone="${esc(phone)}">✎</button>
          <button data-del-anggota="${esc(a.id)}" data-kk-phone="${esc(phone)}">🗑</button>
        </div>
      </div>
    `;
  }).join('') + '<button class="tambah-anggota-btn" data-add="' + esc(phone) + '">+ Tambah Anggota</button>';
}

async function toggleKK(phone){
  if (expandedKK === phone) {
    collapseExpandedKK(false);
    return;
  }
  expandedKK = phone;

  // Instant feedback: update list saja (tidak sentuh search input)
  renderWargaList();
  pushGuard();

  if (anggotaCache[phone] !== undefined) return;

  try {
    const res = await api('listAnggota', session.token, phone);
    anggotaCache[phone] = res.ok ? (res.data || []) : [];
  } catch(e) {
    anggotaCache[phone] = [];
  }
  renderWargaList();
  attachAnggotaHandlers(phone);
}

function collapseExpandedKK(silent){
  silent = silent || false;
  expandedKK = null;
  renderWargaList();
  if (!silent) silentPop();
  else reArmBackGuard();   // ← TAMBAH
}

function attachAnggotaHandlers(phone){
  document.querySelectorAll('[data-add]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); formAnggota(b.dataset.add); };
  });
  document.querySelectorAll('[data-edit-anggota]').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const list = anggotaCache[b.dataset.kkPhone] || [];
      const a = list.find(x => x.id === b.dataset.editAnggota);
      if (a) formAnggota(b.dataset.kkPhone, a);
    };
  });
  document.querySelectorAll('[data-del-anggota]').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      delAnggota(b.dataset.delAnggota, b.dataset.kkPhone);
    };
  });
}

function formAnggota(kkPhone, existing){
  const a = existing || { nama:'', nik:'', jk:'L', tgl_lahir:'', hubungan:'Anak', status_kk:'AKTIF' };
  const isEdit = !!existing;

  openModal(isEdit ? 'Edit Anggota' : 'Tambah Anggota', `
    <div class="field"><label>Nama Lengkap *</label>
      <input type="text" id="aNama" value="${esc(a.nama)}"></div>
    <div class="field"><label>NIK</label>
      <input type="text" id="aNik" value="${esc(a.nik||'')}" placeholder="16 digit"></div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Jenis Kelamin</label>
        <select id="aJk">
          <option value="L" ${a.jk==='L'?'selected':''}>Laki-laki</option>
          <option value="P" ${a.jk==='P'?'selected':''}>Perempuan</option>
        </select></div>
      <div class="field" style="flex:1"><label>Tanggal Lahir</label>
        <input type="date" id="aTgl" value="${esc(a.tgl_lahir||'')}"></div>
    </div>
    <div class="field"><label>Hubungan</label>
      <select id="aHubungan">
        ${['Kepala Keluarga','Istri','Suami','Anak','Orang Tua','Famili','Lainnya'].map(h =>
          '<option ' + (a.hubungan===h?'selected':'') + '>' + h + '</option>').join('')}
      </select></div>
    <div class="field"><label>Status</label>
      <select id="aStatus">
        ${['AKTIF','PINDAH','MENINGGAL'].map(s =>
          '<option ' + (a.status_kk===s?'selected':'') + '>' + s + '</option>').join('')}
      </select></div>
    <button class="btn primary block" onclick="submitAnggota('${esc(kkPhone)}','${esc(a.id||'')}')">Simpan</button>
  `);
}

async function submitAnggota(kkPhone, id){
  if (!acquireSubmitLock()) return;
  try {
    const payload = {
      id: id || undefined,
      kk_phone: kkPhone,
      nama: $('#aNama').value.trim(),
      nik: $('#aNik').value.trim(),
      jk: $('#aJk').value,
      tgl_lahir: $('#aTgl').value,
      hubungan: $('#aHubungan').value,
      status_kk: $('#aStatus').value
    };
    if (!payload.nama) return toast('Nama wajib','error');
    showLoading(true);
    const res = await api('saveAnggota', session.token, payload);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    closeModal(true);
    delete anggotaCache[kkPhone];
    invalidate('users');
    invalidateKeluargaCache();
    toast(res.msg || 'Tersimpan', 'success');
    try {
      const r2 = await api('listAnggota', session.token, kkPhone);
      if (r2.ok) anggotaCache[kkPhone] = r2.data || [];
    } catch(e) {}
    renderWargaList();
  } catch(e) {
    showLoading(false);
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

async function delAnggota(id, kkPhone){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Hapus anggota ini dari keluarga?', {
      title: 'Hapus Anggota', icon: '🗑', type: 'danger',
      okText: 'Hapus', cancelText: 'Batal'
    });
    if (!ok) return;

    showLoading(true);
    const res = await api('deleteAnggota', session.token, id);
    showLoading(false);
    if (!res.ok) return toast(res.msg,'error');
    delete anggotaCache[kkPhone];
    invalidate('users');
    invalidateKeluargaCache();
    toast('Anggota dihapus', 'success');
    const r2 = await api('listAnggota', session.token, kkPhone);
    if (r2.ok) anggotaCache[kkPhone] = r2.data || [];
    renderWargaList();
  } catch(e) {
    showLoading(false);
    toast(e.message,'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ HALAMAN KAS (Transparansi) ============
let kasFilter = { bulan: null };

async function renderKas(force){
  force = force || false;
  const main = $('#mainContent');

  if (!kasFilter.bulan) {
    const now = new Date();
    kasFilter.bulan = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  }

  const cacheKey = 'kas_' + kasFilter.bulan;
  if (force || !cache[cacheKey] || cache[cacheKey].dirty) {
    if (!cache[cacheKey] || !cache[cacheKey].data) main.innerHTML = skeleton();
    try {
      const res = await api('getKasSummary', session.token, kasFilter.bulan);
      if (!res.ok) return toast(res.msg,'error');
      cache[cacheKey] = { data: res.data, dirty: false };
    } catch(e) { return toast('Gagal: '+e.message,'error'); }
  }

  renderKasHTML();
}

function renderKasHTML(){
  const main = $('#mainContent');
  const cacheKey = 'kas_' + kasFilter.bulan;
  const d = cache[cacheKey].data;
  const bulanLabel = formatBulan(kasFilter.bulan);

  const expenses = d.pengeluaran || [];

  main.innerHTML = `
    <div class="filter-bar">
      <div class="filter-item" style="min-width:100%">
        <label>Bulan</label>
        <input type="month" id="kasBulan" value="${kasFilter.bulan}">
      </div>
    </div>

    <div class="kas-hero">
      <div class="card-title">Saldo Kas Akhir ${esc(bulanLabel)}</div>
      <div class="amount">${rupiah(d.saldoAkhir)}</div>
      <div class="sub">Per akhir ${esc(bulanLabel)}</div>
    </div>

    <div class="kas-flow">
      <div class="kas-flow-row">
        <span class="label">Saldo Awal Bulan</span>
        <span class="value">${rupiah(d.saldoAwal)}</span>
      </div>
      <div class="kas-flow-row">
        <span class="label">Iuran Masuk</span>
        <span class="value plus">+ ${rupiah(d.masukBulan)}</span>
      </div>
      <div class="kas-flow-row">
        <span class="label">Pengeluaran</span>
        <span class="value minus">- ${rupiah(d.keluarBulan)}</span>
      </div>
      <div class="kas-flow-row total">
        <span class="label">Saldo Akhir</span>
        <span class="value">${rupiah(d.saldoAkhir)}</span>
      </div>
    </div>

    <div class="kas-section-title">
      📤 Rincian Pengeluaran ${esc(bulanLabel)}
      ${expenses.length ? '(' + expenses.length + ')' : ''}
    </div>

    ${expenses.length === 0
      ? '<div class="empty"><span class="icon">📭</span>Tidak ada pengeluaran bulan ini</div>'
      : expenses.map(p => `
        <div class="kas-expense">
          <div class="left">
            <div class="title">${esc(p.keterangan)}</div>
            <div class="sub">${tgl(p.tanggal)} • <b>${esc(p.kategori)}</b></div>
            ${p.oleh ? '<div class="sub">Dicatat: ' + esc(p.oleh) + '</div>' : ''}
          </div>
          <div class="amount">- ${rupiah(p.nominal)}</div>
        </div>
      `).join('')}
  `;

  $('#kasBulan').onchange = (e) => {
    kasFilter.bulan = e.target.value;
    renderKas(true);
  };
}

// ============ HALAMAN RIWAYAT IURAN SAYA ============
let riwayatFilter = { tahun: null };

async function renderRiwayat(force){
  force = force || false;
  const main = $('#mainContent');

  if (!riwayatFilter.tahun) {
    riwayatFilter.tahun = String(new Date().getFullYear());
  }

  const cacheKey = 'riwayat_' + riwayatFilter.tahun;
  if (force || !cache[cacheKey] || cache[cacheKey].dirty) {
    if (!cache[cacheKey] || !cache[cacheKey].data) main.innerHTML = skeleton();
    try {
      const res = await api('listIuranSaya', session.token, riwayatFilter.tahun);
      if (!res.ok) return toast(res.msg,'error');
      cache[cacheKey] = { data: res, dirty: false };
    } catch(e) { return toast('Gagal: '+e.message,'error'); }
  }

  renderRiwayatHTML();
}

function renderRiwayatHTML(){
  const main = $('#mainContent');
  const cacheKey = 'riwayat_' + riwayatFilter.tahun;
  const d = cache[cacheKey].data;
  const items = d.data || [];
  const total = d.total || 0;

  const now = new Date().getFullYear();
  const tahunOpts = [now, now-1, now-2, now-3];

  const verifiedCount = items.filter(x => x.status === 'VERIFIED').length;
  const pendingCount = items.filter(x => x.status === 'PENDING').length;

  main.innerHTML = `
    <div class="filter-bar">
      <div class="filter-item" style="min-width:100%">
        <label>Tahun</label>
        <select id="riwayatTahun">
          ${tahunOpts.map(y => '<option value="' + y + '" ' + (String(y)===riwayatFilter.tahun?'selected':'') + '>' + y + '</option>').join('')}
        </select>
      </div>
    </div>

    <div class="riwayat-total">
      <div class="label">Total Iuran Terverifikasi ${esc(riwayatFilter.tahun)}</div>
      <div class="amount">${rupiah(total)}</div>
      <div style="font-size:11px;opacity:.9;margin-top:6px">
        ${verifiedCount} pembayaran lunas${pendingCount ? ' • ' + pendingCount + ' pending' : ''}
      </div>
    </div>

    <div class="kas-section-title">
      📜 Histori Pembayaran
    </div>

    ${items.length === 0
      ? '<div class="empty"><span class="icon">📭</span>Belum ada riwayat iuran tahun ini</div>'
      : items.map(it => {
        const cls = String(it.status).toLowerCase();
        const badgeCls = cls === 'verified' ? 'verified' : (cls === 'pending' ? 'pending' : 'rejected');
        const badgeTxt = cls === 'verified' ? '✓ Lunas' : (cls === 'pending' ? '⏳ Pending' : '✗ Ditolak');
        const periodeLabel = it.periode ? formatBulan(it.periode) : tgl(it.tgl_bayar);

        return `
          <div class="riwayat-item ${badgeCls}">
            <div class="left">
              <div class="title">${esc(it.jenis)} — ${esc(periodeLabel)}</div>
              <div class="sub">Metode: <b>${esc(it.metode || '-')}</b></div>
              <div class="sub">Dibayar: ${tgl(it.tgl_bayar)}</div>
              ${it.status === 'VERIFIED' && it.verified_at ? '<div class="sub">Verifikasi: ' + tgl(it.verified_at) + '</div>' : ''}
              ${it.catatan ? '<div class="sub">Catatan: ' + esc(it.catatan) + '</div>' : ''}
              <div class="sub" style="margin-top:4px"><span class="badge ${badgeCls}">${badgeTxt}</span></div>
            </div>
            <div class="amount">${rupiah(it.nominal)}</div>
          </div>
        `;
      }).join('')}
  `;

  $('#riwayatTahun').onchange = (e) => {
    riwayatFilter.tahun = e.target.value;
    renderRiwayat(true);
  };
}

// ============ UPLOAD FILE SURAT (CLIENT) ============
function readFileAsBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
}

async function submitUploadSurat(suratId){
  if (!acquireSubmitLock()) return;
  try {
    const file = window._suratPendingFile;
    if (!file) return toast('Pilih file dulu', 'error');

    const catatan = ($('#sCatatan') && $('#sCatatan').value) || '';
    const surat = (cache.surat.data || []).find(x => x.id === suratId);

    const progress = $('#uploadProgress');
    const bar = $('#uploadProgressBar');
    if (progress) progress.classList.add('active');
    if (bar) { bar.style.width = '20%'; }

    const base64 = await readFileAsBase64(file);
    if (bar) bar.style.width = '50%';

    showLoading(true);
    const res = await api('uploadSuratFile', session.token, suratId, file.name, base64, file.type);
    showLoading(false);
    if (bar) bar.style.width = '100%';

    if (!res.ok) {
      if (progress) progress.classList.remove('active');
      if (bar) bar.style.width = '0%';
      return toast(res.msg, 'error');
    }

    if (catatan && catatan !== (surat && surat.catatan || '')) {
      try {
        await api('updateSuratStatus', session.token, suratId, 'SELESAI', catatan);
      } catch(e) {}
    }

    window._suratPendingFile = null;
    closeModal(true);
    invalidate('home','surat');
    toast('✅ File surat berhasil di-upload. Warga sudah dinotifikasi.', 'success');
    renderSurat(true);
  } catch(e) {
    showLoading(false);
    const progress = $('#uploadProgress');
    if (progress) progress.classList.remove('active');
    toast('Gagal upload: ' + e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

async function hapusFileSurat(suratId){
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog('Hapus file surat ini? File akan dihapus dari Drive.', {
      title: 'Hapus File Surat', icon: '🗑', type: 'danger',
      okText: 'Hapus', cancelText: 'Batal'
    });
    if (!ok) return;

    showLoading(true);
    const res = await api('deleteSuratFile', session.token, suratId);
    showLoading(false);
    if (!res.ok) return toast(res.msg, 'error');
    invalidate('home','surat');
    toast('File dihapus', 'success');
    closeModal(true);
    renderSurat(true);
  } catch(e) {
    showLoading(false);
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

function downloadSurat(id){
  const s = (cache.surat.data || []).find(x => x.id === id);
  if (!s || !s.file_url) return toast('File surat tidak tersedia', 'error');
  window.open(s.file_url, '_blank');
}

// ================================================================
// ==================== KAMPANYE ==================================
// ================================================================

// ============ LIST KAMPANYE ============
async function renderKampanye(force) {
  force = force || false;
  const main = $('#mainContent');
  const cached = kampanyeCache;

  // Ada cache → render instan dulu
  if (cached.data) {
    renderKampanyeHTML();
    if (force || cached.dirty) {
      refreshKampanyeList();
    }
    return;
  }

  // Tidak ada cache → skeleton + fetch
  main.innerHTML = skeleton();
  await refreshKampanyeList();
}

async function refreshKampanyeList() {
  try {
    const res = await api('listKampanye', session.token, {});
    if (!res.ok) {
      if (!kampanyeCache.data) {
        $('#mainContent').innerHTML = '<div class="empty">⚠️ ' + esc(res.msg) + '</div>';
      }
      return;
    }
    kampanyeCache.data = res.data || [];
    kampanyeCache.dirty = false;
    if (currentPage === 'kampanye' && kampanyeView === 'LIST') {
      renderKampanyeHTML();
    }
  } catch (e) {
    if (!kampanyeCache.data) {
      $('#mainContent').innerHTML = '<div class="empty">⚠️ ' + esc(e.message) + '</div>';
    }
  }
}

function renderKampanyeHTML() {
  const main = $('#mainContent');
  const isAdmin = ['ADMIN','BENDAHARA'].includes(session.user.role);
  const all = kampanyeCache.data || [];

  // Jika detail view
  if (kampanyeView === 'DETAIL' && currentKampanyeId) {
    return renderKampanyeDetail();
  }

  // Tab filter status
  const statusFilter = ['AKTIF','SELESAI','BATAL'];
  const filtered = all.filter(k => !k.status || statusFilter.indexOf(k.status) >= 0);

  const isWarga = session.user.role === 'WARGA';

  let bodyHTML = '';

  if (!filtered.length) {
    bodyHTML = '<div class="empty"><span class="icon">📭</span>Belum ada kampanye</div>';
  } else {
    // Untuk warga: pakai getKampanyeSaya agar dapat progress pribadi
    if (isWarga) {
      bodyHTML += '<div class="empty">⏳ Memuat progress...</div>';
      main.innerHTML = headerKampanye(isAdmin) + bodyHTML;
      attachKampanyeHandlers();
      loadKampanyeWarga();
      return;
    }

    // Untuk admin: tampilkan list kampanye biasa
    filtered.forEach(k => {
      const target = Number(k.target_per_kk) || 0;
      const statusCls = k.status === 'AKTIF' ? 'kp-pending' : (k.status === 'SELESAI' ? 'kp-verified' : 'kp-belum');
      const statusLabel = k.status === 'AKTIF' ? '⏳ Aktif' : (k.status === 'SELESAI' ? '✓ Selesai' : '✕ Batal');

      bodyHTML += `
        <div class="kampanye-card ${statusCls}" data-kp="${esc(k.id)}">
          <div class="kp-head">
            <div>
              <div class="kp-title">${esc(k.nama)}</div>
              <div class="kp-subtitle">${esc(k.jenis || 'KEMATIAN')} • Target ${rupiah(target)}/KK</div>
            </div>
            <div class="kp-pill pill-${k.status === 'AKTIF' ? 'pending' : (k.status === 'SELESAI' ? 'verified' : 'belum')}">${statusLabel}</div>
          </div>
          <div class="kp-meta">
            📅 ${esc(k.periode_start || '-')} s/d ${esc(k.periode_end || '-')}
          </div>
          ${k.deskripsi ? '<div class="kp-meta">' + esc(k.deskripsi) + '</div>' : ''}
          <button class="mi-cta" data-kp-detail="${esc(k.id)}" onclick="event.stopPropagation();lihatProgressKampanye('${esc(k.id)}')">
            📊 Lihat Progress →
          </button>
        </div>
      `;
    });
  }

  main.innerHTML = headerKampanye(isAdmin) + bodyHTML;
  attachKampanyeHandlers();
}

function headerKampanye(isAdmin) {
  return `
    <div class="page-app-bar">
      <div class="left-side">
        <button class="icon-btn" onclick="history.back()">←</button>
      </div>
      <div class="title">Kampanye RT</div>
      <div class="right-side">
        ${isAdmin ? '<button class="icon-btn" onclick="formKampanye()" title="Tambah">+</button>' : ''}
      </div>
    </div>
  `;
}

// ============ WARGA: load progress pribadi ============
async function loadKampanyeWarga() {
  const main = $('#mainContent');
  const cached = kampanyeSayaCache;

  if (cached.data) {
    renderKampanyeSayaHTML(cached.data);
    refreshKampanyeSaya();
    return;
  }

  try {
    const res = await api('getKampanyeSaya', session.token);

    // Null-safe: kalau server balas null/gagal
    if (!res || !res.ok) {
      main.innerHTML = headerKampanye(false)
        + '<div class="empty">⚠️ '
        + esc((res && res.msg) || 'Gagal memuat data kampanye. Coba refresh.')
        + '</div>';
      return;
    }

    kampanyeSayaCache.data = res.data || [];
    kampanyeSayaCache.dirty = false;
    renderKampanyeSayaHTML(kampanyeSayaCache.data);
  } catch (e) {
    main.innerHTML = headerKampanye(false)
      + '<div class="empty">⚠️ ' + esc(e.message || 'Error tidak dikenal') + '</div>';
  }
}

// Fallback: tampilkan daftar kampanye biasa (tanpa progress pribadi)
function fallbackKampanyeList(errMsg) {
  const main = $('#mainContent');
  const all = kampanyeCache.data || [];

  let html = headerKampanye(false);
  html += `
    <div class="card" style="background:var(--warn-light);box-shadow:none;
         padding:10px 12px;margin-bottom:12px;font-size:12px;color:var(--warn)">
      ⚠️ Progress pribadi belum tersedia${errMsg ? ': ' + esc(errMsg) : ''}.
      Menampilkan daftar kampanye.
    </div>
  `;

  if (!all.length) {
    html += '<div class="empty"><span class="icon">📭</span>Belum ada kampanye</div>';
  } else {
    all.forEach(k => {
      const target = Number(k.target_per_kk) || 0;
      const statusLabel = k.status === 'AKTIF' ? '⏳ Aktif'
                        : (k.status === 'SELESAI' ? '✓ Selesai' : '✕ Batal');
      const pillCls = k.status === 'AKTIF' ? 'pending'
                    : (k.status === 'SELESAI' ? 'verified' : 'belum');

      html += `
        <div class="kampanye-card kp-${pillCls}">
          <div class="kp-head">
            <div>
              <div class="kp-title">${esc(k.nama)}</div>
              <div class="kp-subtitle">${esc(k.jenis || '-')} • Target ${rupiah(target)}/KK</div>
            </div>
            <div class="kp-pill pill-${pillCls}">${statusLabel}</div>
          </div>
          <div class="kp-meta">📅 ${esc(k.periode_start || '-')} s/d ${esc(k.periode_end || '-')}</div>
          ${k.deskripsi ? '<div class="kp-meta">' + esc(k.deskripsi) + '</div>' : ''}
        </div>
      `;
    });
  }

  main.innerHTML = html;
}

async function refreshKampanyeSaya() {
  try {
    const res = await api('getKampanyeSaya', session.token);
    if (!res || !res.ok) return;   // ← null-safe

    kampanyeSayaCache.data = res.data || [];
    kampanyeSayaCache.dirty = false;
    if (currentPage === 'kampanye' && kampanyeView === 'LIST') {
      renderKampanyeSayaHTML(kampanyeSayaCache.data);
    }
  } catch (e) { /* silent */ }
}

function renderKampanyeSayaHTML(list) {
  const main = $('#mainContent');
  if (!list || !list.length) {
    main.innerHTML = headerKampanye(false) + '<div class="empty"><span class="icon">📭</span>Belum ada kampanye aktif</div>';
    return;
  }

  let html = headerKampanye(false);
  list.forEach(k => {
    const cls = k.status === 'LUNAS' ? 'kp-verified' : (k.status === 'CICIL' ? 'kp-pending' : 'kp-belum');
    const pillCls = k.status === 'LUNAS' ? 'verified' : (k.status === 'CICIL' ? 'pending' : 'belum');
    const pillTxt = k.status === 'LUNAS' ? '✓ LUNAS' : (k.status === 'CICIL' ? '⏳ CICIL' : '✕ BELUM');
    const nominalCls = k.status === 'LUNAS' ? 'c-verified' : (k.status === 'CICIL' ? 'c-pending' : 'c-belum');

    html += `
      <div class="kampanye-card ${cls}">
        <div class="kp-head">
          <div>
            <div class="kp-title">${esc(k.nama)}</div>
            <div class="kp-subtitle">${esc(k.jenis || 'KEMAMPUAN')}</div>
          </div>
          <div class="kp-pill pill-${pillCls}">${pillTxt}</div>
        </div>

        <div class="kp-amount ${nominalCls}">
          ${rupiah(k.total_bayar)}<small> / ${rupiah(k.target)}</small>
        </div>
        <div class="kp-meta">Sisa: <b>${rupiah(k.sisa)}</b></div>

        <div class="kp-progress">
          <div class="kp-progress-label">
            <span>Progress</span>
            <span><b>${k.persen}%</b></span>
          </div>
          <div class="kp-progress-bar">
            <div class="kp-progress-fill ${nominalCls}" style="width:${k.persen}%"></div>
          </div>
        </div>

        <div class="kp-meta" style="margin-top:8px">
          📅 ${esc(k.periode_start || '-')} s/d ${esc(k.periode_end || '-')}
          ${k.jumlah_transaksi > 0 ? '<br>✓ ' + k.jumlah_transaksi + ' kali bayar' : ''}
        </div>
      </div>
    `;
  });

  main.innerHTML = html;
}

// ============ ADMIN: Lihat Progress Kampanye ============
async function lihatProgressKampanye(id) {
  currentKampanyeId = id;
  kampanyeView = 'DETAIL';
  kampanyeWargaFilter.q = '';   // reset search setiap masuk detail
  pushGuard();
  renderKampanyeDetail();
}

async function renderKampanyeDetail(force) {
  force = force || false;
  const main = $('#mainContent');
  const id = currentKampanyeId;
  const cached = kampanyeDetailCache[id];

  // Ada cache → render instan dulu
  if (cached && cached.data) {
    renderKampanyeDetailHTML(cached.data);
    if (force || cached.dirty) {
      refreshKampanyeDetail(id);
    }
    return;
  }

  // Tidak ada cache → skeleton + fetch
  main.innerHTML = skeleton();
  await refreshKampanyeDetail(id);
}

async function refreshKampanyeDetail(id) {
  try {
    const res = await api('getProgressKampanye', session.token, id);
    if (!res.ok) {
      if (!kampanyeDetailCache[id] || !kampanyeDetailCache[id].data) {
        $('#mainContent').innerHTML = '<div class="empty">⚠️ ' + esc(res.msg) + '</div>';
      }
      return;
    }
    kampanyeDetailCache[id] = { data: res.data, dirty: false };
    if (kampanyeView === 'DETAIL' && currentKampanyeId === id) {
      renderKampanyeDetailHTML(res.data);
    }
  } catch (e) {
    if (!kampanyeDetailCache[id] || !kampanyeDetailCache[id].data) {
      $('#mainContent').innerHTML = '<div class="empty">⚠️ ' + esc(e.message) + '</div>';
    }
  }
}

function renderKampanyeDetailHTML(data) {
  const main = $('#mainContent');
  const { kampanye, warga, summary } = data;
  const pct = summary.persenKeseluruhan;

  let html = `
    <div class="blok-detail-header" style="background:linear-gradient(135deg,#9C27B0,#4A148C)">
      <button class="back-btn" onclick="backToKampanyeList()">←</button>
      <div class="info">
        <h3>${esc(kampanye.nama)}</h3>
        <small>${esc(kampanye.jenis || 'KEMAMPUAN')} • ${summary.totalKK} KK</small>
      </div>
      <div class="spacer"></div>
    </div>

    <div class="kp-info-box">
      <b>Target:</b> ${rupiah(kampanye.target_per_kk)} per KK<br>
      <b>Periode:</b> ${esc(kampanye.periode_start)} s/d ${esc(kampanye.periode_end)}<br>
      ${kampanye.deskripsi ? '<b>Info:</b> ' + esc(kampanye.deskripsi) : ''}
    </div>

    <div class="hero-card" style="background:linear-gradient(135deg,#9C27B0,#4A148C);box-shadow:0 8px 24px rgba(156,39,176,.25)">
      <div class="hero-head">
        <div class="hero-icon">🎯</div>
        <div class="hero-label">Total Terkumpul</div>
      </div>
      <div class="hero-value">${rupiah(summary.totalTerkumpul)}</div>
      <div class="hero-chip">${pct}% dari target ${rupiah(summary.totalTarget)}</div>
      <div style="position:relative;z-index:1;margin-top:14px">
        <div style="height:8px;background:rgba(255,255,255,.22);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:#fff;border-radius:4px;transition:width .4s"></div>
        </div>
      </div>
    </div>

    <div class="kp-stats">
      <div class="kp-stat s-lunas"><div class="num">${summary.countLunas}</div><div class="lbl">Lunas</div></div>
      <div class="kp-stat s-cicil"><div class="num">${summary.countCicil}</div><div class="lbl">Cicil</div></div>
      <div class="kp-stat s-belum"><div class="num">${summary.countBelum}</div><div class="lbl">Belum</div></div>
      <div class="kp-stat s-total"><div class="num">${summary.totalKK}</div><div class="lbl">Total KK</div></div>
    </div>

    <div class="btn-row" style="margin-bottom:16px">
      <button class="btn primary" onclick="formBayarKampanye('${esc(kampanye.id)}')">💰 Catat Pembayaran</button>
      <button class="btn outline" onclick="formKampanye('${esc(kampanye.id)}')">✎ Edit</button>
    </div>

    <div class="section-title">Status Warga (${warga.length})</div>

    <div class="kp-warga-toolbar">
      <div class="search-wrap ${kampanyeWargaFilter.q ? 'has-value' : ''}">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input type="text" class="search-input" id="kpWargaSearch"
               placeholder="Cari nama, blok, atau no rumah..." autocomplete="off"
               value="${esc(kampanyeWargaFilter.q)}">
        <button class="search-clear" id="kpWargaSearchClear" type="button" aria-label="Clear">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
          </svg>
        </button>
      </div>
    </div>

    <div id="kpWargaList"></div>
  `;

  main.innerHTML = html;

  renderKampanyeWargaList(warga, kampanye.id);
  attachKampanyeSearchHandlers(warga, kampanye.id);
}

function renderKampanyeWargaList(warga, kampanyeId) {
  const cont = $('#kpWargaList');
  if (!cont) return;

  // Filter pencarian
  const q = kampanyeWargaFilter.q.toLowerCase().trim();
  let filtered = warga || [];
  if (q) {
    filtered = filtered.filter(w => {
      const hay = (
        (w.nama || '') + ' ' +
        (w.blok || '') + ' ' +
        (w.no_rumah || '') + ' ' +
        (w.phone || '')
      ).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  if (!filtered.length) {
    cont.innerHTML = `
      <div class="empty-warga">
        <span class="icon">🔍</span>
        ${q ? 'Tidak ada warga yang cocok dengan "' + esc(kampanyeWargaFilter.q) + '"' : 'Belum ada warga'}
      </div>
    `;
    return;
  }

  // Group per blok
  const groups = {};
  filtered.forEach(w => {
    const b = String(w.blok || 'TANPA BLOK').trim().toUpperCase() || 'TANPA BLOK';
    if (!groups[b]) groups[b] = [];
    groups[b].push(w);
  });

  const blokKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'TANPA BLOK') return 1;
    if (b === 'TANPA BLOK') return -1;
    return a.localeCompare(b);
  });

  let html = '';
  blokKeys.forEach(b => {
    const arr = groups[b];
    const lunas = arr.filter(w => w.status === 'LUNAS').length;
    const cicil = arr.filter(w => w.status === 'CICIL').length;
    const belum = arr.filter(w => w.status === 'BELUM').length;

    html += `
      <div class="kp-blok-group">
        <div class="kp-blok-header">
          <div class="kp-blok-title">
            <span class="kp-blok-name">${b === 'TANPA BLOK' ? '⚠️ Tanpa Blok' : '🏠 Blok ' + esc(b)}</span>
            <span class="kp-blok-count">${arr.length} KK</span>
          </div>
          <div class="kp-blok-stats">
            ${lunas > 0 ? '<span class="kp-mini-stat s-lunas">✓ ' + lunas + '</span>' : ''}
            ${cicil > 0 ? '<span class="kp-mini-stat s-cicil">⏳ ' + cicil + '</span>' : ''}
            ${belum > 0 ? '<span class="kp-mini-stat s-belum">✕ ' + belum + '</span>' : ''}
          </div>
        </div>
    `;

    arr.forEach(w => {
      const cls = w.status === 'LUNAS' ? 's-lunas' : (w.status === 'CICIL' ? 's-cicil' : 's-belum');
      const pillCls = w.status === 'LUNAS' ? 'verified' : (w.status === 'CICIL' ? 'pending' : 'belum');
      const pillTxt = w.status === 'LUNAS' ? '✓ Lunas' : (w.status === 'CICIL' ? '⏳ ' + w.persen + '%' : '✕ Belum');
      const btnLabel = w.status === 'BELUM' ? '+ Bayar' : '💰 Tambah';
      const rumah = w.no_rumah ? 'No ' + esc(w.no_rumah) : '-';

      html += `
        <div class="kp-warga-row ${cls}">
          <div class="row-head">
            <div style="flex:1;min-width:0">
              <div class="name">${esc(w.nama)}</div>
              <div class="sub">${rumah} • ${esc(w.phone)}</div>
              <div class="amount-inline">
                <b>${rupiah(w.total_bayar)}</b> <small>dari ${rupiah(w.target)}</small>
              </div>
            </div>
            <div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
              <span class="badge ${pillCls}">${pillTxt}</span>
              <button class="btn primary sm"
                      onclick="formBayarKampanye('${esc(kampanyeId)}','${esc(w.phone)}')">
                ${btnLabel}
              </button>
            </div>
          </div>
          <div class="bar"><div class="bar-fill" style="width:${w.persen}%"></div></div>
        </div>
      `;
    });

    html += '</div>';
  });

  cont.innerHTML = html;
}

function attachKampanyeSearchHandlers(warga, kampanyeId) {
  const input = $('#kpWargaSearch');
  const clear = $('#kpWargaSearchClear');
  if (!input) return;

  const wrap = input.closest('.search-wrap');

  input.oninput = () => {
    kampanyeWargaFilter.q = input.value;
    if (wrap) wrap.classList.toggle('has-value', !!input.value);
    renderKampanyeWargaList(warga, kampanyeId);
  };

  if (clear) {
    clear.onclick = () => {
      input.value = '';
      kampanyeWargaFilter.q = '';
      if (wrap) wrap.classList.remove('has-value');
      renderKampanyeWargaList(warga, kampanyeId);
      input.focus();
    };
  }
}

function backToKampanyeList(silent) {
  silent = silent || false;
  kampanyeView = 'LIST';
  currentKampanyeId = null;
  renderKampanye(false);
  if (!silent) silentPop();
  else reArmBackGuard();   // ← TAMBAH: kalau dipanggil dari popstate, re-arm
}

// ============ FORM KAMPANYE (Create/Edit) ============
async function formKampanye(id) {
  let k = {
    id: '', nama: '', deskripsi: '',
    target_per_kk: 100000,
    periode_start: new Date().toISOString().substring(0, 10),
    periode_end: new Date().toISOString().substring(0, 10),
    jenis: 'KEMATIAN', status: 'AKTIF'
  };

  if (id) {
    const found = (kampanyeCache.data || []).find(x => x.id === id);
    if (found) k = found;
  }

  openModal(id ? 'Edit Kampanye' : 'Buat Kampanye', `
    <div class="field">
      <label>Nama Kampanye *</label>
      <input type="text" id="kNama" value="${esc(k.nama)}" placeholder="Contoh: Santunan Duka Pak RT">
    </div>

    <div class="field">
      <label>Deskripsi</label>
      <textarea id="kDeskripsi" placeholder="Penjelasan singkat tentang kampanye ini...">${esc(k.deskripsi || '')}</textarea>
    </div>

    <div class="field">
      <label>Jenis</label>
      <select id="kJenis">
        ${['KEMATIAN','SAKIT','SOSIAL','PEMBANGUNAN','LAINNYA'].map(j =>
          '<option ' + (k.jenis === j ? 'selected' : '') + '>' + j + '</option>'
        ).join('')}
      </select>
    </div>

    <div class="field">
      <label>Target per KK (Rp) *</label>
      <input type="number" id="kTarget" value="${k.target_per_kk}" step="1000">
    </div>

    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1">
        <label>Mulai</label>
        <input type="date" id="kStart" value="${esc(k.periode_start || '')}">
      </div>
      <div class="field" style="flex:1">
        <label>Berakhir</label>
        <input type="date" id="kEnd" value="${esc(k.periode_end || '')}">
      </div>
    </div>

    <div class="field">
      <label>Status</label>
      <select id="kStatus">
        ${['AKTIF','SELESAI','BATAL'].map(s =>
          '<option ' + (k.status === s ? 'selected' : '') + '>' + s + '</option>'
        ).join('')}
      </select>
    </div>

    <button class="btn primary block" onclick="submitKampanye('${esc(id || '')}')">Simpan</button>

    ${id ? '<button class="btn danger block" style="margin-top:8px" onclick="hapusKampanye(\'' + esc(id) + '\')">🗑 Hapus Kampanye</button>' : ''}
  `);
}

async function submitKampanye(id) {
  if (!acquireSubmitLock()) return;
  try {
    const payload = {
      id: id || undefined,
      nama: $('#kNama').value.trim(),
      deskripsi: $('#kDeskripsi').value.trim(),
      jenis: $('#kJenis').value,
      target_per_kk: Number($('#kTarget').value),
      periode_start: $('#kStart').value,
      periode_end: $('#kEnd').value,
      status: $('#kStatus').value
    };

    // Validasi lokal dulu
    if (!payload.nama) return toast('Nama wajib', 'error');
    if (!payload.target_per_kk || payload.target_per_kk <= 0) return toast('Target harus > 0', 'error');
    if (!payload.periode_start || !payload.periode_end) return toast('Periode wajib', 'error');

    // ===== TAMPILKAN PROCESS DIALOG =====
    const isEdit = !!id;
    showProcess(
      isEdit ? 'Memperbarui kampanye...' : 'Membuat kampanye...',
      'Mohon tunggu, sedang menyimpan data'
    );

    let res;
    try {
      res = await api('saveKampanye', session.token, payload);
    } catch (err) {
      processError('Gagal terhubung', 'Periksa koneksi internet Anda');
      await sleep(1800);
      hideProcess();
      return;
    }

    // ===== CEK HASIL =====
    if (!res || !res.ok) {
      processError('Gagal menyimpan', (res && res.msg) || 'Terjadi kesalahan tidak dikenal');
      await sleep(2000);
      hideProcess();
      return;
    }

    // ===== SUKSES =====
    processSuccess(
      isEdit ? 'Kampanye diperbarui!' : 'Kampanye dibuat!',
      payload.nama + ' • Target Rp ' + payload.target_per_kk.toLocaleString('id-ID') + '/KK'
    );

    await sleep(1200);
    hideProcess();

    // ===== REFRESH UI =====
    closeModal(true);
    invalidateKampanye();
    invalidateKeuangan();
    toast(res.msg || 'Tersimpan', 'success');
    renderKampanye(true);
  } catch(e) {
    hideProcess();
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

async function hapusKampanye(id) {
  if (!acquireSubmitLock()) return;
  try {
    const ok = await confirmDialog(
      'Hapus kampanye ini? Kampanye yang sudah punya pembayaran tidak bisa dihapus.',
      { title: 'Hapus Kampanye', icon: '🗑', type: 'danger', okText: 'Hapus' }
    );
    if (!ok) return;

    showLoading(true);
    const res = await api('deleteKampanye', session.token, id);
    showLoading(false);
    if (!res.ok) return toast(res.msg, 'error');

    closeModal(true);
    invalidateKampanye();
    toast('Kampanye dihapus', 'success');
    backToKampanyeList(true);
  } catch (e) {
    showLoading(false);
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ FORM BAYAR KAMPANYE ============
async function formBayarKampanye(kampanyeId, prefillPhone) {
  selectedWarga = null;
  const isPrefill = !!prefillPhone;

  // Cari kampanye
  const kampanye = (kampanyeCache.data || []).find(x => x.id === kampanyeId);
  if (!kampanye) return toast('Kampanye tidak ditemukan', 'error');

  if (!wargaCache) wargaCache = loadWargaCache();

  openModal('Catat Pembayaran Kampanye', `
    <div class="kp-info-box" style="margin-bottom:14px">
      <b>${esc(kampanye.nama)}</b><br>
      Target: ${rupiah(kampanye.target_per_kk)} per KK
    </div>

    <!-- CHIP WARGA (kalau prefill) -->
    <div id="kpSelectedContainer"></div>

    <!-- SEARCH FIELD (kalau tidak prefill) -->
    <div class="field" id="kpSearchField" ${isPrefill ? 'style="display:none"' : ''}>
      <label>Nama Kepala Keluarga *</label>
      <div class="search-wrap" id="searchWrap">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input type="text" class="search-input" id="wargaSearch" placeholder="Cari nama..." autocomplete="off">
        <button class="search-clear" id="searchClear" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
          </svg>
        </button>
        <div class="search-list" id="searchList"></div>
      </div>
    </div>

    <div class="field">
      <label>Nominal (Rp) *</label>
      <input type="number" id="kbNominal" value="${kampanye.target_per_kk}" step="1000">
    </div>

    <div class="field">
      <label>Tanggal Bayar</label>
      <input type="date" id="kbTanggal" value="${new Date().toISOString().substring(0, 10)}">
    </div>

    <div class="field">
      <label>Metode</label>
      <select id="kbMetode">
        <option value="CASH">Tunai</option>
        <option value="TF">Transfer</option>
      </select>
    </div>

    <div class="field">
      <label>Catatan</label>
      <input type="text" id="kbCatatan" placeholder="Opsional">
    </div>

    <button class="btn primary block" onclick="submitBayarKampanye('${esc(kampanyeId)}')">Simpan Pembayaran</button>
  `);

  setupWargaSearch();

  // ===== Kalau PREFILL: pastikan cache ada, lalu auto-pilih =====
  if (isPrefill) {
    if (!wargaCache) {
      try {
        const res = await api('getAllWargaAktif', session.token);
        if (res && res.ok) {
          wargaCache = res.data || [];
          saveWargaCache(wargaCache);
        }
      } catch (e) { /* silent */ }
    }

    if (wargaCache) {
      const w = wargaCache.find(x => x.phone === prefillPhone);
      if (w) {
        selectWarga(w);   // otomatis render chip
        setTimeout(() => {
          const nom = $('#kbNominal');
          if (nom) { nom.focus(); nom.select(); }
        }, 200);
      }
    }
    return;
  }

  // ===== TANPA PREFILL: load warga di background =====
  if (!wargaCache) {
    try {
      const res = await api('getAllWargaAktif', session.token);
      if (res && res.ok) {
        wargaCache = res.data || [];
        saveWargaCache(wargaCache);
        const list = $('#searchList');
        if (list) list.innerHTML = '';
      }
    } catch (e) { /* silent */ }
  }
}

async function submitBayarKampanye(kampanyeId) {
  if (!acquireSubmitLock()) return;
  try {
    if (!selectedWarga) return toast('Pilih warga dulu', 'error');

    const nominal = Number($('#kbNominal').value);
    if (!nominal || nominal <= 0) return toast('Nominal tidak valid', 'error');

    const payload = {
      phone: selectedWarga.phone,
      jenis: 'KEMATIAN',
      periode: '',
      nominal: nominal,
      metode: $('#kbMetode').value,
      catatan: $('#kbCatatan').value || '',
      tgl_bayar: $('#kbTanggal').value,
      kampanye_id: kampanyeId
    };

    // ===== TAMPILKAN PROCESS DIALOG =====
    showProcess('Menyimpan pembayaran...', 'Mohon tunggu, sedang mencatat pembayaran kampanye');

    let res;
    try {
      res = await api('submitIuran', session.token, payload);
    } catch (err) {
      processError('Gagal terhubung', 'Periksa koneksi internet Anda');
      await sleep(1800);
      hideProcess();
      return;
    }

    // ===== CEK HASIL =====
    if (!res || !res.ok) {
      processError('Gagal menyimpan', (res && res.msg) || 'Terjadi kesalahan tidak dikenal');
      await sleep(2000);
      hideProcess();
      return;
    }

    // ===== SUKSES =====
    processSuccess(
      'Pembayaran tersimpan!',
      'Rp ' + nominal.toLocaleString('id-ID') + ' • ' + selectedWarga.nama
    );

    await sleep(1200);
    hideProcess();

    // ===== REFRESH UI =====
    closeModal(true);
    invalidateKeuangan();
    invalidateKampanye();
    clearWargaCache();
    toast('Pembayaran tercatat untuk ' + selectedWarga.nama, 'success');

    // Refresh halaman detail kampanye
    if (kampanyeView === 'DETAIL' && currentKampanyeId) {
      renderKampanyeDetail(true);   // force refresh agar data terbaru
    } else {
      renderKampanye(true);
    }
  } catch (e) {
    hideProcess();
    toast(e.message, 'error');
  } finally {
    releaseSubmitLock();
  }
}

// ============ ATTACH HANDLERS ============
function attachKampanyeHandlers() {
  // Klik card → detail progress (khusus admin)
  $$('.kampanye-card[data-kp]').forEach(c => {
    c.onclick = () => lihatProgressKampanye(c.dataset.kp);
  });
}
