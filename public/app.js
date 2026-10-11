const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n ?? 0).toLocaleString('id-ID', { maximumFractionDigits: d });
const rp = (n) => 'Rp ' + fmt(n, 0);
const today = () => new Date().toISOString().slice(0, 10);
const LABEL = {
  pembelian: 'Pembelian', hibah_masuk: 'Hibah Masuk', transfer_masuk: 'Transfer Masuk', perolehan_lain: 'Perolehan Lainnya',
  pemakaian: 'Pemakaian', hibah_keluar: 'Hibah Keluar', transfer_keluar: 'Transfer Keluar',
  penyesuaian_masuk: 'Penyesuaian Opname (+)', penyesuaian_keluar: 'Penyesuaian Opname (−)',
};
const PIHAK = { MASUK: 'Pemasok / Pemberi', KELUAR: 'Penerima / Unit Tujuan' };
const NAMA_LEVEL = ['Golongan', 'Bidang', 'Kelompok', 'Sub Kelompok', 'Sub-sub Kelompok'];
// 10 digit => 1.01.01.01.001 (Golongan.Bidang.Kelompok.Sub Kelompok.Sub-sub Kelompok)
const fmtKode = (k) => String(k ?? '').replace(/^(\d)(\d{2})?(\d{2})?(\d{2})?(\d{3})?$/, (_, ...g) => g.slice(0, 5).filter(Boolean).join('.'));
const ROLE = { SUPER_ADMIN: 'Super Admin', OPERATOR: 'Operator', APPROVER: 'Approver' };

const state = { me: null, unit: sessionStorage.getItem('unit') || '' };
const isSA = () => state.me.role === 'SUPER_ADMIN', isOP = () => state.me.role === 'OPERATOR', isAP = () => state.me.role === 'APPROVER';

async function api(method, url, body) {
  if (method === 'GET' && state.unit && isSA()) url += (url.includes('?') ? '&' : '?') + 'unit_id=' + state.unit;
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && state.me) { state.me = null; showLogin('Sesi berakhir, silakan login kembali'); }
  if (!r.ok) throw new Error(j.error || 'Terjadi kesalahan');
  return j;
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const formData = (form) => Object.fromEntries(new FormData(form));
const badge = (s) => `<span class="badge ${s}">${esc(s)}</span>`;
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'n' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Belum ada data</td></tr>`}</tbody></table></div>`;
const itemOptions = (items, sel) => items.map((i) => `<option value="${i.id}" ${i.id == sel ? 'selected' : ''}>${esc(i.kode)} — ${esc(i.nama)} (stok ${fmt(i.stok)} ${esc(i.satuan)})</option>`).join('');

function barChart(series, key = 'qty') {
  const W = 700, H = 220, pad = 28, max = Math.max(...series.map((s) => s[key]), 1);
  const bw = (W - pad * 2) / series.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Grafik tren pemakaian">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="currentColor" opacity=".2"/>
    ${series.map((s, i) => {
      const h = (s[key] / max) * (H - pad * 2), x = pad + i * bw + bw * 0.15;
      return `<rect x="${x}" y="${H - pad - h}" width="${bw * 0.7}" height="${h}" rx="3" fill="var(--pri)"><title>${s.bulan}: ${fmt(s[key])}</title></rect>
        <text x="${x + bw * 0.35}" y="${H - 10}" text-anchor="middle">${s.bulan.slice(2)}</text>
        ${s[key] ? `<text x="${x + bw * 0.35}" y="${H - pad - h - 4}" text-anchor="middle">${fmt(s[key], 0)}</text>` : ''}`;
    }).join('')}</svg>`;
}

// ---------- Ekspor Excel / PDF ----------
// Tombol ekspor; input [data-p] di dalamnya (mis. rentang tanggal) ikut dikirim sebagai parameter.
function eksporBtn(nama, params = {}, { rentang = false } = {}) {
  const q = new URLSearchParams(params);
  if (isSA() && state.unit && !q.has('unit_id')) q.set('unit_id', state.unit);
  const tgl = rentang ? `<label class="inl">Dari <input type="date" data-p="dari"></label><label class="inl">Sampai <input type="date" data-p="sampai"></label>` : '';
  return `<span class="ekspor" data-nama="${nama}" data-q="${esc(q.toString())}">${tgl}<span class="muted">Ekspor:</span>
    <button type="button" class="sec" data-fmt="xlsx">Excel</button><button type="button" class="sec" data-fmt="pdf">PDF</button></span>`;
}
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('.ekspor [data-fmt]');
  if (!b) return;
  const box = b.closest('.ekspor'), q = new URLSearchParams(box.dataset.q);
  box.querySelectorAll('[data-p]').forEach((i) => i.value && q.set(i.dataset.p, i.value));
  q.set('format', b.dataset.fmt);
  const teks = b.textContent; b.disabled = true; b.textContent = '…';
  try {
    const r = await fetch(`/api/ekspor/${box.dataset.nama}?${q}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Ekspor gagal');
    const nama = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `${box.dataset.nama}.${b.dataset.fmt}`;
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: nama });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${nama} diunduh`);
  } finally { b.disabled = false; b.textContent = teks; }
}));

// ---------- Login / sesi ----------
const guest = (html) => { $('#hdr').hidden = true; $('#view').innerHTML = `<div class="card login">${html}</div>`; };
let config = null;
async function getConfig() {
  if (!config) config = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ sso: null, password_login: true, reset_password: false }));
  return config;
}
let guestSeq = 0; // render halaman tamu yang basi (async) tidak boleh menimpa yang lebih baru
async function showLogin(msg = '', seq = ++guestSeq) {
  const cfg = await getConfig();
  if (seq !== guestSeq) return;
  guest(`<h2>Masuk ke Stok Gudang</h2>
    ${cfg.sso ? `<a class="btn" href="/api/auth/sso/login">${esc(cfg.sso.label)}</a>${cfg.password_login ? '<p class="muted" style="text-align:center;margin:8px 0">atau</p>' : ''}` : ''}
    <form id="f">
    <label>Username<input name="username" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <div class="err" id="err">${esc(msg)}</div><button>Masuk</button></form>
    ${cfg.reset_password ? '<p><a href="#lupa">Lupa password?</a></p>' : ''}
    ${!cfg.password_login ? '<p class="muted">Login password hanya untuk super admin.</p>' : ''}`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formData(e.target)) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      state.me = j.user; location.hash = ''; start();
    } catch (er) { $('#err').textContent = er.message; }
  };
}
function showForgot() {
  guest(`<h2>Lupa password</h2><form id="f"><label>Username atau email<input name="identifier" required autofocus></label>
    <div class="err" id="err"></div><button>Kirim tautan reset</button></form><p><a href="#">← Kembali ke login</a></p>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/auth/lupa-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formData(e.target)) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      guest(`<h2>Periksa email Anda</h2><p>${esc(j.pesan)}</p><p class="muted">Tautan berlaku 30 menit dan hanya dapat dipakai sekali. Akun tanpa email terdaftar tidak dapat memakai fitur ini; hubungi super admin.</p><p><a href="#">← Kembali ke login</a></p>`);
    } catch (er) { $('#err').textContent = er.message; }
  };
}
let resetToken = null;
function showReset(token) {
  if (token) resetToken = token; // disimpan di memori: render ulang tidak boleh kehilangan token
  history.replaceState(null, '', '#reset'); // token tidak perlu tetap di bilah alamat
  guest(`<h2>Buat password baru</h2><form id="f"><label>Password baru (min. 8 karakter)<input name="password_baru" type="password" minlength="8" required autocomplete="new-password" autofocus></label>
    <label>Ulangi password<input name="ulang" type="password" minlength="8" required autocomplete="new-password"></label>
    <div class="err" id="err"></div><button>Simpan password</button></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.password_baru !== d.ulang) { $('#err').textContent = 'Kedua password tidak sama'; return; }
    try {
      const r = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken, password_baru: d.password_baru }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      location.hash = ''; showLogin('Password diubah. Silakan login dengan password baru.');
    } catch (er) { $('#err').textContent = er.message; }
  };
}
function guestRoute() {
  const seq = ++guestSeq;
  const [name, qs] = location.hash.slice(1).split('?');
  if (name === 'reset') return showReset(new URLSearchParams(qs).get('token'));
  if (name === 'lupa') return showForgot();
  showLogin(name.startsWith('sso-error=') ? decodeURIComponent(name.slice(10)) : '', seq);
}
async function start() {
  const nav = [['dashboard', 'Dashboard'], ['barang', 'Barang'], ['masuk', 'Transaksi Masuk'], ['keluar', 'Transaksi Keluar'], ['transfer', 'Transfer'], ['opname', 'Stok Opname'], ['laporan', 'Laporan']];
  if (isAP()) nav.splice(1, 0, ['persetujuan', 'Persetujuan']);
  if (isSA()) nav.push(['kodebarang', 'Kode Barang'], ['admin', 'Admin']);
  $('#nav').innerHTML = nav.map(([h, t]) => `<a href="#${h}">${t}</a>`).join('');
  $('#me').textContent = `${state.me.nama} · ${ROLE[state.me.role]}${state.me.unit_kode ? ' · ' + state.me.unit_kode : ''}`;
  $('#hdr').hidden = false;
  const uf = $('#unitfilter');
  uf.hidden = !isSA();
  if (isSA()) {
    const units = await api('GET', '/api/unit');
    uf.innerHTML = `<option value="">Semua unit</option>` + units.map((u) => `<option value="${u.id}" ${u.id == state.unit ? 'selected' : ''}>${esc(u.kode)}</option>`).join('');
    uf.onchange = () => { state.unit = uf.value; sessionStorage.setItem('unit', state.unit); render(); };
  }
  render();
}

// ---------- Halaman ----------
const views = {
  async dashboard(el) {
    const d = await api('GET', '/api/dashboard');
    const list = (rows) => table([...(isSA() ? ['Unit'] : []), 'Kode', 'Barang', '#Stok', '#Minimum'], rows.map((i) =>
      `<tr>${isSA() ? `<td>${esc(i.unit_kode)}</td>` : ''}<td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td class="n">${fmt(i.stok)} ${esc(i.satuan)}</td><td class="n">${fmt(i.stok_minimum)}</td></tr>`));
    el.innerHTML = `<div class="grid">
      <div class="stat"><b>${fmt(d.jumlah_barang)}</b><span>Jenis barang aktif</span></div>
      <div class="stat"><b>${rp(d.nilai_persediaan)}</b><span>Nilai persediaan (rata-rata tertimbang)</span></div>
      <div class="stat"><b style="color:var(--bad)">${d.kosong.length}</b><span>Stok kosong</span></div>
      <div class="stat"><b style="color:var(--warn)">${d.menipis.length}</b><span>Stok menipis</span></div>
      <div class="stat"><b>${d.transaksi_bulan_ini}</b><span>Transaksi disetujui bulan ini</span></div>
      <div class="stat"><b style="color:var(--warn)">${d.menunggu_transaksi + d.menunggu_opname}</b><span>Transaksi/opname menunggu persetujuan${isAP() ? ' — <a href="#persetujuan">buka</a>' : ''}</span></div>
      <div class="stat"><b style="color:var(--warn)">${d.transfer_perlu_tindakan}</b><span>Transfer perlu tindakan — <a href="#transfer">buka</a></span></div></div>
      <div class="card"><div class="tb"><h2>Stok kosong</h2>${eksporBtn('stok', { status: 'KOSONG' })}</div>${list(d.kosong)}</div>
      <div class="card"><div class="tb"><h2>Stok menipis (≤ minimum)</h2>${eksporBtn('stok', { status: 'MENIPIS' })}</div>${list(d.menipis)}</div>`;
  },

  async barang(el) {
    const items = await api('GET', '/api/items?semua=1');
    const form = isOP() ? `<div class="card"><h2>Tambah / ubah barang</h2>
      <form class="row" id="f"><input type="hidden" name="id">
        <label>Kode<input name="kode" required></label><label>Nama<input name="nama" required></label>
        <label>Kategori<input name="kategori" placeholder="ATK, Kebersihan…"></label><label>Satuan<input name="satuan" value="unit"></label>
        <label>Kode barang (10 digit, opsional)<input name="kode_barang" list="kbl" inputmode="numeric" autocomplete="off" placeholder="1.01.01.01.001"><datalist id="kbl"></datalist><small class="muted" id="kbinfo"></small></label>
        <label>Stok minimum<input name="stok_minimum" type="number" min="0" step="any" value="0"></label>
        <label>Status<select name="aktif"><option value="1">Aktif</option><option value="0">Nonaktif</option></select></label>
        <div><button>Simpan</button> <button type="button" class="sec" id="reset">Batal</button></div></form></div>` : '';
    el.innerHTML = `${form}<div class="card"><div class="tb"><h2>Daftar barang</h2>${eksporBtn('stok')}</div>${table([...(isSA() ? ['Unit'] : []), 'Kode', 'Nama', 'Kode Barang', 'Kategori', 'Satuan', '#Stok', '#Min', '#Harga rata-rata', 'Status', ...(isOP() ? [''] : [])], items.map((i) =>
        `<tr style="${i.aktif ? '' : 'opacity:.5'}">${isSA() ? `<td>${esc(i.unit_kode)}</td>` : ''}<td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td title="${esc(i.kode_barang_uraian ?? '')}">${i.kode_barang ? esc(fmtKode(i.kode_barang)) : '—'}</td><td>${esc(i.kategori)}</td><td>${esc(i.satuan)}</td>
        <td class="n">${fmt(i.stok)}</td><td class="n">${fmt(i.stok_minimum)}</td><td class="n">${rp(i.harga_rata)}</td><td>${badge(i.status)}</td>
        ${isOP() ? `<td><button class="sec" data-edit="${i.id}">Ubah</button> <button class="del" data-del="${i.id}">Hapus</button></td>` : ''}</tr>`))}</div>`;
    if (!isOP()) return;
    const f = $('#f');
    $('#reset').onclick = () => { f.reset(); $('#kbinfo').textContent = ''; };
    let tmr;
    f.elements.kode_barang.oninput = (e) => { // saran kode dari referensi, ketik kode atau uraian
      clearTimeout(tmr);
      const q = e.target.value.trim();
      tmr = setTimeout(guard(async () => {
        if (!q) { $('#kbl').innerHTML = ''; $('#kbinfo').textContent = ''; return; }
        const { rows } = await api('GET', `/api/kode-barang?level=5&aktif=1&limit=15&q=${encodeURIComponent(q)}`);
        $('#kbl').innerHTML = rows.map((r) => `<option value="${fmtKode(r.kode)}">${esc(r.uraian)}</option>`).join('');
        const tepat = rows.find((r) => r.kode === q.replace(/\D/g, ''));
        $('#kbinfo').textContent = tepat ? tepat.uraian : '';
      }), 250);
    };
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const b = formData(f); b.aktif = b.aktif === '1';
      b.id ? await api('PUT', `/api/items/${b.id}`, b) : await api('POST', '/api/items', b);
      toast('Barang tersimpan'); render();
    });
    el.onclick = guard(async (e) => {
      const ed = e.target.dataset.edit, del = e.target.dataset.del;
      if (ed) { const i = items.find((x) => x.id == ed); for (const k of ['id', 'kode', 'nama', 'kategori', 'satuan', 'stok_minimum']) f.elements[k].value = i[k]; f.elements.kode_barang.value = fmtKode(i.kode_barang); $('#kbinfo').textContent = i.kode_barang_uraian ?? ''; f.elements.aktif.value = i.aktif; scrollTo(0, 0); }
      if (del && confirm('Hapus barang ini?')) { await api('DELETE', `/api/items/${del}`); toast('Barang dihapus'); render(); }
    });
  },

  async masuk(el) { return transaksi(el, 'MASUK', ['pembelian', 'hibah_masuk', 'transfer_masuk', 'perolehan_lain']); },
  async keluar(el) { return transaksi(el, 'KELUAR', ['pemakaian', 'hibah_keluar', 'transfer_keluar']); },

  async persetujuan(el) {
    const [rows, ops, trs] = await Promise.all([api('GET', '/api/transaksi?status=MENUNGGU&limit=500'), api('GET', '/api/opname'), api('GET', '/api/transfer')]);
    const antre = ops.filter((o) => o.status === 'DIAJUKAN');
    const antreTr = trs.filter((t) => t.aksi.includes('setujui') || t.aksi.includes('tolak'));
    el.innerHTML = `<div class="card"><h2>Transaksi menunggu persetujuan (${rows.length})</h2>${table(['Tanggal', 'Jenis', 'Kategori', 'Barang', '#Jumlah', '#Harga', 'Pihak', 'Dokumen', 'Diajukan oleh', ''], rows.map((t) =>
      `<tr><td>${t.tanggal}</td><td>${badge(t.jenis)}</td><td>${LABEL[t.kategori]}</td><td>${esc(t.kode)} — ${esc(t.nama)}</td><td class="n">${fmt(t.qty)} ${esc(t.satuan)}</td>
      <td class="n">${t.jenis === 'MASUK' ? rp(t.harga_satuan) : '—'}</td><td>${esc(t.pihak)}</td><td>${esc(t.no_dokumen)}</td><td>${esc(t.pembuat)}</td>
      <td><button class="ok" data-ok="${t.id}">Setujui</button> <button class="no" data-no="${t.id}">Tolak</button></td></tr>`))}</div>
      <div class="card"><h2>Transfer antar-unit menunggu keputusan (${antreTr.length})</h2>${transferTable(antreTr, [])}</div>
      <div class="card"><h2>Opname menunggu persetujuan (${antre.length})</h2>${table(['Tipe', 'Periode', 'Tanggal', '#Selisih', ''], antre.map((o) =>
      `<tr><td>${o.tipe}</td><td>${esc(o.periode)}</td><td>${o.tanggal}</td><td class="n">${o.jumlah_selisih}</td><td><a href="#opname?id=${o.id}">Tinjau</a></td></tr>`))}</div>`;
    el.onclick = guard(async (e) => {
      if (await transferClick(e)) return;
      const { ok, no } = e.target.dataset;
      if (ok) { await api('POST', `/api/transaksi/${ok}/setujui`, {}); toast('Transaksi disetujui'); render(); }
      if (no) { const catatan = prompt('Alasan penolakan:'); if (catatan) { await api('POST', `/api/transaksi/${no}/tolak`, { catatan }); toast('Transaksi ditolak'); render(); } }
    });
  },

  async opname(el) {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('id');
    if (id) return opnameDetail(el, id);
    const list = await api('GET', '/api/opname');
    const now = new Date(), bln = now.toISOString().slice(0, 7);
    const form = isOP() ? `<div class="card"><h2>Mulai stok opname</h2><form class="row" id="f">
      <label>Tipe<select name="tipe" id="tipe"><option value="BULANAN">Bulanan</option><option value="SEMESTER">Semester</option></select></label>
      <label>Periode<input name="periode" id="periode" value="${bln}" required></label>
      <label>Tanggal<input type="date" name="tanggal" value="${today()}"></label>
      <label>Catatan<input name="catatan"></label><div><button>Buat lembar opname</button></div></form>
      <p class="muted">Bulanan: YYYY-MM (mis. ${bln}). Semester: YYYY-S1 atau YYYY-S2.</p></div>` : '';
    el.innerHTML = `${form}<div class="card"><h2>Riwayat opname</h2>${table([...(isSA() ? ['Unit'] : []), 'Tipe', 'Periode', 'Tanggal', 'Status', '#Barang', '#Selisih', ''], list.map((o) =>
        `<tr>${isSA() ? `<td>${esc(o.unit_kode)}</td>` : ''}<td>${o.tipe}</td><td>${esc(o.periode)}</td><td>${o.tanggal}</td><td>${badge(o.status)}</td><td class="n">${o.jumlah_barang}</td><td class="n">${o.jumlah_selisih}</td>
        <td><a href="#opname?id=${o.id}">${o.status === 'DRAFT' && isOP() ? 'Isi' : 'Lihat'}</a></td></tr>`))}</div>`;
    if (!isOP()) return;
    const f = $('#f');
    $('#tipe').onchange = (e) => { $('#periode').value = e.target.value === 'SEMESTER' ? `${now.getFullYear()}-S${now.getMonth() < 6 ? 1 : 2}` : bln; };
    f.onsubmit = guard(async (e) => { e.preventDefault(); const o = await api('POST', '/api/opname', formData(f)); location.hash = `#opname?id=${o.id}`; });
  },

  async laporan(el) {
    const items = await api('GET', '/api/items');
    const q = new URLSearchParams(location.hash.split('?')[1]);
    const bulan = q.get('bulan') || 12, item = q.get('item') || '', kat = q.get('kat') || 'pemakaian';
    const [t, kartu] = await Promise.all([
      api('GET', `/api/laporan/trend?bulan=${bulan}&kategori=${kat}&item_id=${item}`),
      item ? api('GET', `/api/laporan/kartu-stok?item_id=${item}`) : null,
    ]);
    el.innerHTML = `<div class="card"><form class="bar" id="f">
      <label>Barang<select name="item"><option value="">Semua barang</option>${items.map((i) => `<option value="${i.id}" ${i.id == item ? 'selected' : ''}>${isSA() ? esc(i.unit_kode) + ' · ' : ''}${esc(i.kode)} — ${esc(i.nama)}</option>`).join('')}</select></label>
      <label>Jenis<select name="kat"><option value="pemakaian">Pemakaian</option><option value="semua">Semua keluar</option>
        ${['hibah_keluar', 'transfer_keluar'].map((k) => `<option value="${k}">${LABEL[k]}</option>`).join('')}</select></label>
      <label>Rentang<select name="bulan">${[6, 12, 24].map((n) => `<option value="${n}">${n} bulan</option>`).join('')}</select></label>
      <button>Terapkan</button></form>
      <div class="tb"><h2>Tren barang keluar per bulan (kuantitas)</h2>${eksporBtn('tren', { bulan, kategori: kat, ...(item ? { item_id: item } : {}) })}</div>${barChart(t.series)}</div>
      <div class="card"><h2>Pemakaian terbanyak & perkiraan sisa stok (90 hari terakhir)</h2>${table([...(isSA() ? ['Unit'] : []), 'Kode', 'Barang', '#Pemakaian 90 hr', '#Rata-rata/bulan', '#Stok', '#Perkiraan habis dalam', 'Status'], t.top.map((i) =>
        `<tr>${isSA() ? `<td>${esc(i.unit_kode)}</td>` : ''}<td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td class="n">${fmt(i.pemakaian_90_hari)}</td><td class="n">${fmt(i.rata_per_bulan)}</td>
        <td class="n">${fmt(i.stok)} ${esc(i.satuan)}</td><td class="n">${i.sisa_hari == null ? '—' : fmt(i.sisa_hari, 0) + ' hari'}</td><td>${badge(i.status)}</td></tr>`))}</div>
      ${kartu ? `<div class="card"><div class="tb"><h2>Kartu stok: ${esc(kartu.item.nama)}</h2>${eksporBtn('kartu-stok', { item_id: item })}</div>${table(['Tanggal', 'Kategori', 'Dokumen', '#Masuk', '#Keluar', '#Saldo'], kartu.rows.map((r) =>
        `<tr><td>${r.tanggal}</td><td>${LABEL[r.kategori]}</td><td>${esc(r.no_dokumen)}</td><td class="n">${r.jenis === 'MASUK' ? fmt(r.qty) : ''}</td><td class="n">${r.jenis === 'KELUAR' ? fmt(r.qty) : ''}</td><td class="n">${fmt(r.saldo)}</td></tr>`))}</div>` : ''}`;
    const f = $('#f'); f.kat.value = kat; f.bulan.value = bulan;
    f.onsubmit = (e) => { e.preventDefault(); const d = formData(f); location.hash = `#laporan?item=${d.item}&kat=${d.kat}&bulan=${d.bulan}`; };
  },

  async akun(el) {
    el.innerHTML = `<div class="card" style="max-width:420px"><h2>Akun saya</h2><p>${esc(state.me.nama)} · ${esc(state.me.username)}<br><span class="muted">Email: ${esc(state.me.email ?? 'belum diisi — hubungi super admin agar SSO dan reset password dapat dipakai')}</span></p><h2>Ubah password</h2><form id="f" style="display:grid;gap:12px">
      <label>Password saat ini<input type="password" name="password_lama" required autocomplete="current-password"></label>
      <label>Password baru (min. 8 karakter)<input type="password" name="password_baru" minlength="8" required autocomplete="new-password"></label>
      <div><button>Simpan</button></div></form></div>`;
    $('#f').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/auth/ubah-password', formData(e.target)); e.target.reset(); toast('Password diubah'); });
  },

  async admin(el) {
    if (!isSA()) throw new Error('Tidak berwenang');
    const [users, units, log] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/unit'), api('GET', '/api/audit')]);
    const unitSel = `<option value="">—</option>` + units.filter((u) => u.aktif).map((u) => `<option value="${u.id}">${esc(u.kode)} — ${esc(u.nama)}</option>`).join('');
    el.innerHTML = `<div class="card"><h2>Unit / Fakultas</h2>
      <form class="row" id="fu"><label>Kode<input name="kode" required></label><label>Nama<input name="nama" required></label><div><button>Tambah unit</button></div></form>
      ${table(['Kode', 'Nama', 'Status', ''], units.map((u) => `<tr><td>${esc(u.kode)}</td><td>${esc(u.nama)}</td><td>${u.aktif ? 'Aktif' : 'Nonaktif'}</td>
        <td><button class="sec" data-unit="${u.id}" data-aktif="${u.aktif ? 0 : 1}">${u.aktif ? 'Nonaktifkan' : 'Aktifkan'}</button></td></tr>`))}</div>
      <div class="card"><h2>Pengguna</h2>
      <form class="row" id="fp"><input type="hidden" name="id">
        <label>Username<input name="username" required></label><label>Nama<input name="nama" required></label>
        <label>Email (untuk SSO &amp; reset password)<input name="email" type="email"></label>
        <label>Role<select name="role"><option value="OPERATOR">Operator</option><option value="APPROVER">Approver</option><option value="SUPER_ADMIN">Super Admin</option></select></label>
        <label>Unit<select name="unit_id">${unitSel}</select></label>
        <label>Password <span id="pwhint">(wajib)</span><input name="password" type="password" minlength="8" autocomplete="new-password"></label>
        <label>Status<select name="aktif"><option value="1">Aktif</option><option value="0">Nonaktif</option></select></label>
        <div><button>Simpan</button> <button type="button" class="sec" id="reset">Batal</button></div></form>
      ${table(['Username', 'Nama', 'Email', 'Role', 'Unit', 'Status', ''], users.map((u) => `<tr style="${u.aktif ? '' : 'opacity:.5'}"><td>${esc(u.username)}</td><td>${esc(u.nama)}</td><td>${esc(u.email ?? '—')}</td><td>${ROLE[u.role]}</td>
        <td>${esc(u.unit_kode ?? '—')}</td><td>${u.aktif ? 'Aktif' : 'Nonaktif'}</td><td><button class="sec" data-user="${u.id}">Ubah</button></td></tr>`))}</div>
      <div class="card"><h2>Log audit (200 terakhir)</h2>${table(['Waktu (UTC)', 'Pengguna', 'Aksi', 'Detail'], log.map((a) => `<tr><td>${a.waktu}</td><td>${esc(a.username ?? '—')}</td><td>${esc(a.aksi)}</td><td>${esc(a.detail)}</td></tr>`))}</div>`;
    $('#fu').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/unit', formData(e.target)); toast('Unit ditambahkan'); render(); });
    const fp = $('#fp');
    $('#reset').onclick = () => { fp.reset(); fp.elements.username.readOnly = false; $('#pwhint').textContent = '(wajib)'; };
    fp.onsubmit = guard(async (e) => {
      e.preventDefault();
      const b = formData(fp); b.aktif = b.aktif === '1';
      if (b.id) { if (!b.password) delete b.password; await api('PUT', `/api/users/${b.id}`, b); } else await api('POST', '/api/users', b);
      toast('Pengguna tersimpan'); render();
    });
    el.onclick = guard(async (e) => {
      const { unit, aktif, user } = e.target.dataset;
      if (unit) { const u = units.find((x) => x.id == unit); await api('PUT', `/api/unit/${unit}`, { nama: u.nama, aktif: aktif === '1' }); render(); }
      if (user) {
        const u = users.find((x) => x.id == user);
        for (const k of ['id', 'username', 'nama', 'role']) fp.elements[k].value = u[k];
        fp.elements.email.value = u.email ?? '';
        fp.elements.unit_id.value = u.unit_id ?? ''; fp.elements.aktif.value = u.aktif;
        fp.elements.username.readOnly = true; $('#pwhint').textContent = '(kosongkan jika tidak diubah)'; scrollTo(0, 0);
      }
    });
  },
};

views.kodebarang = async (el) => {
  if (!isSA()) throw new Error('Tidak berwenang');
  el.innerHTML = `<div class="card"><h2>Tambah kode barang persediaan</h2>
    <p class="muted">Format SAKTI: 10 digit <b>X.XX.XX.XX.XXX</b> = Golongan · Bidang · Kelompok · Sub Kelompok · Sub-sub Kelompok. Tambahkan dari tingkat atas (induk harus ada lebih dulu). Barang dipasangkan ke tingkat ke-5 (10 digit). Kode persediaan diawali golongan 1.</p>
    <form class="row" id="fk"><label>Kode<input name="kode" required inputmode="numeric" autocomplete="off" placeholder="1.01.01.01.001"></label>
      <label>Uraian<input name="uraian" required maxlength="200"></label>
      <div><button>Simpan</button> <span class="muted" id="lvl"></span></div></form></div>
    <div class="card"><h2>Impor massal</h2>
    <p class="muted">Tempel baris <code>kode;uraian</code> (pemisah titik-koma, koma, tab, atau spasi; baris header boleh). Urutan bebas, induk boleh ada di dalam berkas yang sama. Kode yang sudah ada dilewati. Jika ada satu baris salah, tidak ada yang disimpan.</p>
    <form id="fi"><textarea name="teks" rows="6" style="width:100%" placeholder="1;Persediaan&#10;101;…&#10;10101;…"></textarea><div class="bar"><button>Impor</button></div></form></div>
    <div class="card"><div class="tb"><h2>Daftar kode barang</h2>${eksporBtn('kode-barang')}</div>
    <form class="bar" id="ff"><label>Cari kode / uraian<input name="q"></label>
      <label>Tingkat<select name="level"><option value="">Semua</option>${NAMA_LEVEL.map((n, i) => `<option value="${i + 1}">${i + 1} — ${n}</option>`).join('')}</select></label><button>Cari</button></form>
    <div id="daftar"></div></div>`;
  const fk = $('#fk'), ff = $('#ff');
  fk.elements.kode.oninput = (e) => {
    const d = e.target.value.replace(/\D/g, ''), lv = [1, 3, 5, 7, 10].indexOf(d.length);
    $('#lvl').textContent = !d ? '' : lv >= 0 ? `${NAMA_LEVEL[lv]} → ${fmtKode(d)}` : `${d.length} digit (harus 1, 3, 5, 7, atau 10)`;
  };
  const muat = guard(async () => {
    const p = new URLSearchParams({ limit: 300 });
    for (const [k, v] of Object.entries(formData(ff))) if (v) p.set(k, v);
    const { rows, terpotong } = await api('GET', `/api/kode-barang?${p}`);
    $('#daftar').innerHTML = (terpotong ? '<p class="muted">Menampilkan 300 pertama; persempit pencarian.</p>' : '') +
      table(['Kode', 'Tingkat', 'Uraian', 'Status', '#Barang', ''], rows.map((r) =>
        `<tr style="${r.aktif ? '' : 'opacity:.5'}"><td style="padding-left:${10 + (r.level - 1) * 14}px"><code>${fmtKode(r.kode)}</code></td><td>${NAMA_LEVEL[r.level - 1]}</td><td style="white-space:normal">${esc(r.uraian)}</td>
        <td>${r.aktif ? 'Aktif' : 'Nonaktif'}</td><td class="n">${r.level === 5 ? r.dipakai : ''}</td>
        <td><button class="sec" data-ubah="${r.kode}">Ubah</button> <button class="sec" data-aktif="${r.kode}" data-nilai="${r.aktif ? 0 : 1}">${r.aktif ? 'Nonaktifkan' : 'Aktifkan'}</button> <button class="del" data-hapus="${r.kode}">Hapus</button></td></tr>`));
    $('#daftar').rows = rows;
  });
  ff.onsubmit = (e) => { e.preventDefault(); muat(); };
  fk.onsubmit = guard(async (e) => { e.preventDefault(); const r = await api('POST', '/api/kode-barang', formData(fk)); toast(`Ditambahkan: ${fmtKode(r.kode)}`); fk.elements.uraian.value = ''; fk.elements.kode.focus(); muat(); });
  $('#fi').onsubmit = guard(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/kode-barang/impor', formData(e.target));
    toast(`${r.ditambahkan} kode ditambahkan, ${r.dilewati} dilewati`); e.target.reset(); muat();
  });
  el.onclick = guard(async (e) => {
    const { ubah, aktif, nilai, hapus } = e.target.dataset;
    const row = (k) => $('#daftar').rows.find((r) => r.kode === k);
    if (ubah) { const u = prompt(`Uraian untuk ${fmtKode(ubah)}:`, row(ubah).uraian); if (u) { await api('PUT', `/api/kode-barang/${ubah}`, { uraian: u, aktif: !!row(ubah).aktif }); toast('Uraian diubah'); muat(); } }
    if (aktif) { await api('PUT', `/api/kode-barang/${aktif}`, { uraian: row(aktif).uraian, aktif: nilai === '1' }); muat(); }
    if (hapus && confirm(`Hapus kode ${fmtKode(hapus)}?`)) { await api('DELETE', `/api/kode-barang/${hapus}`); toast('Kode dihapus'); muat(); }
  });
  muat();
};

const TR_STATUS = { DIAJUKAN: 'Menunggu persetujuan pengirim', DIKIRIM: 'Dikirim — menunggu penerimaan', DIPERIKSA: 'Diterima operator — menunggu persetujuan', DITERIMA: 'Selesai', DITOLAK_ASAL: 'Ditolak pengirim', DIKEMBALIKAN: 'Dikembalikan ke pengirim', DIBATALKAN: 'Dibatalkan' };
const trBadge = (st) => `<span class="badge ${st === 'DITERIMA' ? 'DISETUJUI' : st === 'DIKIRIM' || st === 'DIPERIKSA' || st === 'DIAJUKAN' ? 'MENUNGGU' : 'DITOLAK'}" title="${esc(st)}">${esc(TR_STATUS[st])}</span>`;
function transferTable(rows, myItems) {
  return table(['#', 'Tanggal', 'Dari', 'Ke', 'Barang asal', '#Jumlah', 'Barang di tujuan', 'Status', 'Tindakan'], rows.map((t) => {
    const aksi = [];
    if (t.aksi.includes('batal')) aksi.push(`<button class="del" data-tr="${t.id}" data-do="batal">Batalkan</button>`);
    if (t.aksi.includes('setujui')) aksi.push(`<button class="ok" data-tr="${t.id}" data-do="setujui">${t.status === 'DIAJUKAN' ? 'Setujui &amp; kirim' : 'Setujui penerimaan'}</button>`);
    if (t.aksi.includes('tolak')) aksi.push(`<button class="no" data-tr="${t.id}" data-do="tolak">Tolak</button>`);
    if (t.aksi.includes('terima')) {
      const cocok = myItems.filter((i) => i.aktif && i.satuan.toLowerCase() === t.satuan.toLowerCase());
      aksi.push(`<label class="inl">Diterima <input type="number" data-qty="${t.id}" min="0" max="${t.qty}" step="any" value="${t.qty_diterima ?? t.qty}"> ${esc(t.satuan)}</label>
        <select data-map="${t.id}"><option value="">Petakan ke barang…</option>${cocok.map((i) => `<option value="${i.id}" ${i.id == t.item_tujuan_id ? 'selected' : ''}>${esc(i.kode)} — ${esc(i.nama)}</option>`).join('')}</select>
        <button data-tr="${t.id}" data-do="terima-map">Terima</button> <button class="sec" data-tr="${t.id}" data-do="terima-baru">Buat barang baru</button>`);
    }
    return `<tr><td>${t.id}</td><td>${t.tanggal}</td><td>${esc(t.unit_asal_kode)}</td><td>${esc(t.unit_tujuan_kode)}</td><td>${esc(t.item_asal_kode)} — ${esc(t.item_asal_nama)}</td>
      <td class="n">${fmt(t.qty)} ${esc(t.satuan)}${t.qty_diterima != null && t.qty_diterima !== t.qty && ['DIPERIKSA', 'DITERIMA'].includes(t.status) ? `<div class="muted" style="font-size:12px">diterima ${fmt(t.qty_diterima)}</div>` : ''}</td><td>${t.item_tujuan_kode ? esc(t.item_tujuan_kode) + ' — ' + esc(t.item_tujuan_nama) : '—'}</td>
      <td>${trBadge(t.status)}${t.catatan_keputusan ? `<div class="muted" style="font-size:12px">${esc(t.catatan_keputusan)}</div>` : ''}${t.catatan_penerimaan ? `<div class="muted" style="font-size:12px">Selisih: ${esc(t.catatan_penerimaan)}</div>` : ''}</td><td style="white-space:normal">${aksi.join(' ')}</td></tr>`;
  }));
}
// Menangani klik tombol transfer; true bila ditangani
async function transferClick(e) {
  const id = e.target.dataset.tr, d = e.target.dataset.do;
  if (!id) return false;
  const post = async (path, body, pesan) => { await api('POST', `/api/transfer/${id}/${path}`, body); toast(pesan); render(); };
  if (d === 'batal') { if (confirm('Batalkan transfer ini?')) await post('batal', {}, 'Transfer dibatalkan'); }
  else if (d === 'setujui') await post('setujui', {}, 'Transfer disetujui');
  else if (d === 'tolak') { const catatan = prompt('Alasan penolakan:'); if (catatan) await post('tolak', { catatan }, 'Transfer ditolak'); }
  else if (d === 'terima-map' || d === 'terima-baru') {
    const qi = document.querySelector(`input[data-qty="${id}"]`);
    const body = { qty_diterima: qi.value };
    if (!(Number(qi.value) > 0)) throw new Error('Jumlah diterima harus lebih dari 0');
    if (Number(qi.value) < Number(qi.max)) { // penerimaan sebagian: wajib alasan, sisanya kembali ke unit asal
      const alasan = prompt(`Diterima ${qi.value} dari ${qi.max}. Sisa ${fmt(qi.max - qi.value)} akan kembali ke unit pengirim.\nAlasan selisih:`);
      if (!alasan) return true;
      body.catatan = alasan;
    }
    if (d === 'terima-map') {
      body.item_id = document.querySelector(`select[data-map="${id}"]`).value;
      if (!body.item_id) throw new Error('Pilih barang di unit Anda, atau gunakan "Buat barang baru"');
    } else {
      if (!confirm('Buat barang baru di unit Anda dengan kode dan nama yang sama?')) return true;
      body.buat_item_baru = true;
    }
    await post('terima', body, 'Penerimaan dicatat, menunggu persetujuan approver');
  }
  return true;
}

views.transfer = async (el) => {
  const [rows, items, units] = await Promise.all([api('GET', '/api/transfer'), isOP() ? api('GET', '/api/items?semua=1') : [], isOP() ? api('GET', '/api/unit/tujuan') : []]);
  const form = isOP() ? `<div class="card"><h2>Ajukan transfer ke unit lain</h2><form class="row" id="f">
    <label>Tanggal<input type="date" name="tanggal" value="${today()}" required></label>
    <label>Unit tujuan<select name="unit_tujuan_id" required>${units.map((u) => `<option value="${u.id}">${esc(u.kode)} — ${esc(u.nama)}</option>`).join('')}</select></label>
    <label>Barang<select name="item_id" required>${itemOptions(items.filter((i) => i.aktif && i.stok > 0))}</select></label>
    <label>Jumlah<input type="number" name="qty" min="0.0001" step="any" required></label>
    <label>No. dokumen<input name="no_dokumen"></label><label>Keterangan<input name="keterangan"></label><div><button>Ajukan</button></div></form>
    <p class="muted">Alur: approver unit Anda menyetujui (stok Anda berkurang) → operator unit tujuan memetakan barang → approver unit tujuan menyetujui (stok tujuan bertambah). Jika ditolak tujuan, stok kembali ke unit Anda.</p></div>` : '';
  el.innerHTML = `${form}<div class="card"><div class="tb"><h2>Transfer antar-unit</h2>${eksporBtn('transfer')}</div>${transferTable(rows, items)}</div>`;
  if (isOP()) $('#f').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/transfer', formData(e.target)); toast('Transfer diajukan'); render(); });
  el.onclick = guard(transferClick);
};

async function transaksi(el, jenis, kategori) {
  const [items, rows] = await Promise.all([isOP() ? api('GET', '/api/items') : [], api('GET', `/api/transaksi?jenis=${jenis}&limit=100`)]);
  const hasPrice = jenis === 'MASUK';
  const form = isOP() ? `<div class="card"><h2>Catat transaksi ${jenis === 'MASUK' ? 'masuk' : 'keluar'}</h2><form class="row" id="f">
    <label>Tanggal<input type="date" name="tanggal" value="${today()}" required></label>
    <label>Kategori<select name="kategori">${kategori.map((k) => `<option value="${k}">${LABEL[k]}${k.startsWith('transfer') ? ' (pihak luar)' : ''}</option>`).join('')}</select></label>
    <label>Barang<select name="item_id" required>${itemOptions(items)}</select></label>
    <label>Jumlah<input type="number" name="qty" min="0.0001" step="any" required></label>
    ${hasPrice ? '<label>Harga satuan (Rp)<input type="number" name="harga_satuan" min="0" step="any" value="0"></label>' : ''}
    <label>${PIHAK[jenis]}<input name="pihak"></label><label>No. dokumen<input name="no_dokumen"></label>
    <label>Keterangan<input name="keterangan"></label><div><button>Ajukan</button></div></form>
    <p class="muted">Untuk perpindahan antar-unit di aplikasi ini gunakan menu <a href="#transfer">Transfer</a>. Transaksi berstatus <b>Menunggu</b> dan baru memengaruhi stok setelah disetujui approver unit.${hasPrice ? ' Isi harga 0 untuk hibah/transfer bila tidak ada nilai.' : ' Nilai pemakaian dihitung dari harga rata-rata saat disetujui.'}</p></div>` : '';
  el.innerHTML = `${form}<div class="card"><div class="tb"><h2>100 transaksi terakhir</h2>${eksporBtn('transaksi', { jenis }, { rentang: true })}</div>${table([...(isSA() ? ['Unit'] : []), 'Tanggal', 'Kategori', 'Barang', '#Jumlah', hasPrice ? '#Harga' : '#Nilai', 'Pihak', 'Dokumen', 'Status', ...(isOP() ? [''] : [])], rows.map((t) =>
      `<tr>${isSA() ? `<td>${esc(t.unit_kode)}</td>` : ''}<td>${t.tanggal}</td><td>${LABEL[t.kategori]}</td><td>${esc(t.kode)} — ${esc(t.nama)}</td><td class="n">${fmt(t.qty)} ${esc(t.satuan)}</td>
      <td class="n">${t.status === 'MENUNGGU' && !hasPrice ? '—' : rp(hasPrice ? t.harga_satuan : t.harga_satuan * t.qty)}</td><td>${esc(t.pihak)}</td><td>${esc(t.no_dokumen)}${t.transfer_id ? ` <a href="#transfer">TRF#${t.transfer_id}</a>` : ''}</td>
      <td>${badge(t.status)}${t.status === 'DITOLAK' ? `<div class="muted" style="font-size:12px">${esc(t.catatan_keputusan)}</div>` : ''}</td>
      ${isOP() ? `<td>${t.status === 'DISETUJUI' ? '' : `<button class="del" data-del="${t.id}">${t.status === 'MENUNGGU' ? 'Batalkan' : 'Hapus'}</button>`}</td>` : ''}</tr>`))}</div>`;
  if (!isOP()) return;
  const f = $('#f');
  f.onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/transaksi', formData(f)); toast('Transaksi diajukan untuk persetujuan'); render(); });
  el.onclick = guard(async (e) => {
    const id = e.target.dataset.del;
    if (id && confirm('Hapus transaksi ini?')) { await api('DELETE', `/api/transaksi/${id}`); toast('Transaksi dihapus'); render(); }
  });
}

async function opnameDetail(el, id) {
  const o = await api('GET', `/api/opname/${id}`);
  const edit = isOP() && o.status === 'DRAFT';
  const info = { DRAFT: 'Isi stok fisik hasil hitung, lalu ajukan ke approver.', DIAJUKAN: 'Menunggu keputusan approver. Finalisasi akan membuat transaksi penyesuaian untuk setiap selisih.', FINAL: 'Opname final; selisih sudah dicatat sebagai transaksi penyesuaian.' }[o.status];
  el.innerHTML = `<div class="card"><div class="tb"><h2>Opname ${o.tipe.toLowerCase()} ${esc(o.periode)} · ${esc(o.unit_kode)} ${badge(o.status)}</h2>${eksporBtn('opname', { id })}</div>
    <p class="muted">Tanggal ${o.tanggal}. ${info}</p>
    ${o.catatan_keputusan && o.status === 'DRAFT' ? `<div class="note">Dikembalikan approver: ${esc(o.catatan_keputusan)}</div>` : ''}
    <form id="f">${table(['Kode', 'Barang', '#Stok sistem', '#Stok fisik', '#Selisih', 'Keterangan'], o.lines.map((l) =>
      `<tr data-item="${l.item_id}"><td>${esc(l.kode)}</td><td>${esc(l.nama)}</td><td class="n">${fmt(l.stok_sistem)} ${esc(l.satuan)}</td>
      <td class="n">${edit ? `<input type="number" step="any" min="0" name="fisik" value="${l.stok_fisik ?? ''}" style="width:100px">` : fmt(l.stok_fisik)}</td>
      <td class="n sel" data-sis="${l.stok_sistem}">${l.selisih == null ? '' : fmt(l.selisih)}</td>
      <td>${edit ? `<input name="ket" value="${esc(l.keterangan)}">` : esc(l.keterangan)}</td></tr>`))}
    <div class="bar" style="margin-top:12px">
      ${edit ? '<button>Simpan draft</button> <button type="button" class="ok" id="ajukan">Ajukan ke approver</button>' : ''}
      ${isAP() && o.status === 'DIAJUKAN' ? '<button type="button" class="ok" id="fin">Setujui &amp; finalisasi</button> <button type="button" class="no" id="back">Kembalikan</button>' : ''}
      <a href="#${isAP() ? 'persetujuan' : 'opname'}">← Kembali</a></div></form></div>`;
  const f = $('#f');
  const act = (sel, fn) => { const b = $(sel); if (b) b.onclick = guard(fn); };
  if (edit) {
    const collect = () => [...f.querySelectorAll('tr[data-item]')].map((tr) => ({ item_id: tr.dataset.item, stok_fisik: tr.querySelector('[name=fisik]').value, keterangan: tr.querySelector('[name=ket]').value }));
    f.addEventListener('input', (e) => {
      const s = e.target.closest('tr')?.querySelector('.sel');
      if (s && e.target.name === 'fisik') s.textContent = e.target.value === '' ? '' : fmt(e.target.value - s.dataset.sis);
    });
    f.onsubmit = guard(async (e) => { e.preventDefault(); await api('PUT', `/api/opname/${id}`, { lines: collect() }); toast('Draft tersimpan'); });
    act('#ajukan', async () => {
      await api('PUT', `/api/opname/${id}`, { lines: collect() });
      await api('POST', `/api/opname/${id}/ajukan`, {}); toast('Opname diajukan'); render();
    });
  }
  act('#fin', async () => {
    if (!confirm('Finalisasi opname? Stok akan disesuaikan dan opname tidak dapat diubah lagi.')) return;
    await api('POST', `/api/opname/${id}/finalisasi`, {}); toast('Opname difinalisasi'); render();
  });
  act('#back', async () => {
    const catatan = prompt('Alasan pengembalian:'); if (!catatan) return;
    await api('POST', `/api/opname/${id}/kembalikan`, { catatan }); toast('Opname dikembalikan'); render();
  });
}

async function render() {
  if (!state.me) return;
  const name = location.hash.slice(1).split('?')[0] || 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.hash.slice(1) === name));
  const el = $('#view'); el.onclick = null;
  try { await (views[name] || views.dashboard)(el); } catch (e) { if (state.me) el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
addEventListener('hashchange', () => (state.me ? render() : guestRoute()));
$('#logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); state.me = null; location.hash = ''; showLogin(); };

(async () => {
  try { state.me = (await api('GET', '/api/auth/me')).user; } catch { state.me = null; }
  state.me ? start() : guestRoute();
})();
