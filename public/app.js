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

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
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

const views = {
  async dashboard(el) {
    const d = await api('GET', '/api/dashboard');
    const list = (rows) => table(['Kode', 'Barang', '#Stok', '#Minimum'], rows.map((i) =>
      `<tr><td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td class="n">${fmt(i.stok)} ${esc(i.satuan)}</td><td class="n">${fmt(i.stok_minimum)}</td></tr>`));
    el.innerHTML = `<div class="grid">
      <div class="stat"><b>${fmt(d.jumlah_barang)}</b><span>Jenis barang aktif</span></div>
      <div class="stat"><b>${rp(d.nilai_persediaan)}</b><span>Nilai persediaan (rata-rata tertimbang)</span></div>
      <div class="stat"><b style="color:var(--bad)">${d.kosong.length}</b><span>Stok kosong</span></div>
      <div class="stat"><b style="color:var(--warn)">${d.menipis.length}</b><span>Stok menipis</span></div>
      <div class="stat"><b>${d.transaksi_bulan_ini}</b><span>Transaksi bulan ini</span></div></div>
      <div class="card"><h2>Stok kosong</h2>${list(d.kosong)}</div>
      <div class="card"><h2>Stok menipis (≤ minimum)</h2>${list(d.menipis)}</div>`;
  },

  async barang(el) {
    const items = await api('GET', '/api/items?semua=1');
    el.innerHTML = `<div class="card"><h2>Tambah / ubah barang</h2>
      <form class="row" id="f"><input type="hidden" name="id">
        <label>Kode<input name="kode" required></label><label>Nama<input name="nama" required></label>
        <label>Kategori<input name="kategori" placeholder="ATK, Kebersihan…"></label><label>Satuan<input name="satuan" value="unit"></label>
        <label>Stok minimum<input name="stok_minimum" type="number" min="0" step="any" value="0"></label>
        <label>Status<select name="aktif"><option value="1">Aktif</option><option value="0">Nonaktif</option></select></label>
        <div><button>Simpan</button> <button type="button" class="sec" id="reset">Batal</button></div></form></div>
      <div class="card"><h2>Daftar barang</h2>${table(['Kode', 'Nama', 'Kategori', 'Satuan', '#Stok', '#Min', '#Harga rata-rata', 'Status', ''], items.map((i) =>
        `<tr style="${i.aktif ? '' : 'opacity:.5'}"><td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td>${esc(i.kategori)}</td><td>${esc(i.satuan)}</td>
        <td class="n">${fmt(i.stok)}</td><td class="n">${fmt(i.stok_minimum)}</td><td class="n">${rp(i.harga_rata)}</td><td>${badge(i.status)}</td>
        <td><button class="sec" data-edit="${i.id}">Ubah</button> <button class="del" data-del="${i.id}">Hapus</button></td></tr>`))}</div>`;
    const f = $('#f');
    $('#reset').onclick = () => f.reset();
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const b = formData(f); b.aktif = b.aktif === '1';
      b.id ? await api('PUT', `/api/items/${b.id}`, b) : await api('POST', '/api/items', b);
      toast('Barang tersimpan'); render();
    });
    el.onclick = guard(async (e) => {
      const ed = e.target.dataset.edit, del = e.target.dataset.del;
      if (ed) { const i = items.find((x) => x.id == ed); for (const k of ['id', 'kode', 'nama', 'kategori', 'satuan', 'stok_minimum']) f.elements[k].value = i[k]; f.elements.aktif.value = i.aktif; scrollTo(0, 0); }
      if (del && confirm('Hapus barang ini?')) { await api('DELETE', `/api/items/${del}`); toast('Barang dihapus'); render(); }
    });
  },

  async masuk(el) { return transaksi(el, 'MASUK', ['pembelian', 'hibah_masuk', 'transfer_masuk', 'perolehan_lain']); },
  async keluar(el) { return transaksi(el, 'KELUAR', ['pemakaian', 'hibah_keluar', 'transfer_keluar']); },

  async opname(el) {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('id');
    if (id) return opnameDetail(el, id);
    const list = await api('GET', '/api/opname');
    const now = new Date(), bln = now.toISOString().slice(0, 7);
    el.innerHTML = `<div class="card"><h2>Mulai stok opname</h2><form class="row" id="f">
      <label>Tipe<select name="tipe" id="tipe"><option value="BULANAN">Bulanan</option><option value="SEMESTER">Semester</option></select></label>
      <label>Periode<input name="periode" id="periode" value="${bln}" required></label>
      <label>Tanggal<input type="date" name="tanggal" value="${today()}"></label>
      <label>Catatan<input name="catatan"></label><div><button>Buat lembar opname</button></div></form>
      <p class="muted">Bulanan: YYYY-MM (mis. ${bln}). Semester: YYYY-S1 atau YYYY-S2.</p></div>
      <div class="card"><h2>Riwayat opname</h2>${table(['Tipe', 'Periode', 'Tanggal', 'Status', '#Barang', '#Selisih', ''], list.map((o) =>
        `<tr><td>${o.tipe}</td><td>${esc(o.periode)}</td><td>${o.tanggal}</td><td>${badge(o.status)}</td><td class="n">${o.jumlah_barang}</td><td class="n">${o.jumlah_selisih}</td>
        <td><a href="#opname?id=${o.id}">${o.status === 'FINAL' ? 'Lihat' : 'Isi'}</a></td></tr>`))}</div>`;
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
      <label>Barang<select name="item"><option value="">Semua barang</option>${itemOptions(items, item)}</select></label>
      <label>Jenis<select name="kat"><option value="pemakaian">Pemakaian</option><option value="semua">Semua keluar</option>
        ${['hibah_keluar', 'transfer_keluar'].map((k) => `<option value="${k}">${LABEL[k]}</option>`).join('')}</select></label>
      <label>Rentang<select name="bulan">${[6, 12, 24].map((n) => `<option value="${n}">${n} bulan</option>`).join('')}</select></label>
      <button>Terapkan</button></form>
      <h2>Tren barang keluar per bulan (kuantitas)</h2>${barChart(t.series)}</div>
      <div class="card"><h2>Pemakaian terbanyak & perkiraan sisa stok (90 hari terakhir)</h2>${table(['Kode', 'Barang', '#Pemakaian 90 hr', '#Rata-rata/bulan', '#Stok', '#Perkiraan habis dalam', 'Status'], t.top.map((i) =>
        `<tr><td>${esc(i.kode)}</td><td>${esc(i.nama)}</td><td class="n">${fmt(i.pemakaian_90_hari)}</td><td class="n">${fmt(i.rata_per_bulan)}</td>
        <td class="n">${fmt(i.stok)} ${esc(i.satuan)}</td><td class="n">${i.sisa_hari == null ? '—' : fmt(i.sisa_hari, 0) + ' hari'}</td><td>${badge(i.status)}</td></tr>`))}</div>
      ${kartu ? `<div class="card"><h2>Kartu stok: ${esc(kartu.item.nama)}</h2>${table(['Tanggal', 'Kategori', 'Dokumen', '#Masuk', '#Keluar', '#Saldo'], kartu.rows.map((r) =>
        `<tr><td>${r.tanggal}</td><td>${LABEL[r.kategori]}</td><td>${esc(r.no_dokumen)}</td><td class="n">${r.jenis === 'MASUK' ? fmt(r.qty) : ''}</td><td class="n">${r.jenis === 'KELUAR' ? fmt(r.qty) : ''}</td><td class="n">${fmt(r.saldo)}</td></tr>`))}</div>` : ''}`;
    const f = $('#f'); f.kat.value = kat; f.bulan.value = bulan;
    f.onsubmit = (e) => { e.preventDefault(); const d = formData(f); location.hash = `#laporan?item=${d.item}&kat=${d.kat}&bulan=${d.bulan}`; };
  },
};

async function transaksi(el, jenis, kategori) {
  const [items, rows] = await Promise.all([api('GET', '/api/items'), api('GET', `/api/transaksi?jenis=${jenis}&limit=100`)]);
  const hasPrice = jenis === 'MASUK';
  el.innerHTML = `<div class="card"><h2>Catat transaksi ${jenis === 'MASUK' ? 'masuk' : 'keluar'}</h2><form class="row" id="f">
    <label>Tanggal<input type="date" name="tanggal" value="${today()}" required></label>
    <label>Kategori<select name="kategori">${kategori.map((k) => `<option value="${k}">${LABEL[k]}</option>`).join('')}</select></label>
    <label>Barang<select name="item_id" required>${itemOptions(items)}</select></label>
    <label>Jumlah<input type="number" name="qty" min="0.0001" step="any" required></label>
    ${hasPrice ? '<label>Harga satuan (Rp)<input type="number" name="harga_satuan" min="0" step="any" value="0"></label>' : ''}
    <label>${PIHAK[jenis]}<input name="pihak"></label><label>No. dokumen<input name="no_dokumen"></label>
    <label>Keterangan<input name="keterangan"></label><div><button>Simpan</button></div></form>
    ${hasPrice ? '<p class="muted">Isi harga 0 untuk hibah/transfer bila tidak ada nilai.</p>' : '<p class="muted">Nilai pemakaian dihitung dari harga rata-rata barang. Transaksi ditolak bila stok tidak cukup.</p>'}</div>
    <div class="card"><h2>100 transaksi terakhir</h2>${table(['Tanggal', 'Kategori', 'Barang', '#Jumlah', hasPrice ? '#Harga' : '#Nilai', 'Pihak', 'Dokumen', ''], rows.map((t) =>
      `<tr><td>${t.tanggal}</td><td>${LABEL[t.kategori]}</td><td>${esc(t.kode)} — ${esc(t.nama)}</td><td class="n">${fmt(t.qty)} ${esc(t.satuan)}</td>
      <td class="n">${rp(hasPrice ? t.harga_satuan : t.harga_satuan * t.qty)}</td><td>${esc(t.pihak)}</td><td>${esc(t.no_dokumen)}</td>
      <td>${t.opname_id ? '' : `<button class="del" data-del="${t.id}">Hapus</button>`}</td></tr>`))}</div>`;
  const f = $('#f');
  f.onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/transaksi', formData(f)); toast('Transaksi tersimpan'); render(); });
  el.onclick = guard(async (e) => {
    const id = e.target.dataset.del;
    if (id && confirm('Hapus transaksi ini?')) { await api('DELETE', `/api/transaksi/${id}`); toast('Transaksi dihapus'); render(); }
  });
}

async function opnameDetail(el, id) {
  const o = await api('GET', `/api/opname/${id}`);
  const final = o.status === 'FINAL';
  el.innerHTML = `<div class="card"><h2>Opname ${o.tipe.toLowerCase()} ${esc(o.periode)} ${badge(o.status)}</h2>
    <p class="muted">Tanggal ${o.tanggal}. ${final ? 'Opname final; selisih sudah dicatat sebagai transaksi penyesuaian.' : 'Isi stok fisik hasil hitung. Finalisasi akan membuat transaksi penyesuaian untuk setiap selisih.'}</p>
    <form id="f">${table(['Kode', 'Barang', '#Stok sistem', '#Stok fisik', '#Selisih', 'Keterangan'], o.lines.map((l) =>
      `<tr data-item="${l.item_id}"><td>${esc(l.kode)}</td><td>${esc(l.nama)}</td><td class="n">${fmt(l.stok_sistem)} ${esc(l.satuan)}</td>
      <td class="n">${final ? fmt(l.stok_fisik) : `<input type="number" step="any" min="0" name="fisik" value="${l.stok_fisik ?? ''}" style="width:100px">`}</td>
      <td class="n sel" data-sis="${l.stok_sistem}">${l.selisih == null ? '' : fmt(l.selisih)}</td>
      <td>${final ? esc(l.keterangan) : `<input name="ket" value="${esc(l.keterangan)}">`}</td></tr>`))}
    ${final ? '' : '<div class="bar" style="margin-top:12px"><button>Simpan draft</button> <button type="button" class="sec" id="fin">Finalisasi</button></div>'}
    <a href="#opname">← Kembali</a></form></div>`;
  if (final) return;
  const f = $('#f');
  const collect = () => [...f.querySelectorAll('tr[data-item]')].map((tr) => ({ item_id: tr.dataset.item, stok_fisik: tr.querySelector('[name=fisik]').value, keterangan: tr.querySelector('[name=ket]').value }));
  f.addEventListener('input', (e) => {
    const tr = e.target.closest('tr'), s = tr?.querySelector('.sel');
    if (s && e.target.name === 'fisik') s.textContent = e.target.value === '' ? '' : fmt(e.target.value - s.dataset.sis);
  });
  f.onsubmit = guard(async (e) => { e.preventDefault(); await api('PUT', `/api/opname/${id}`, { lines: collect() }); toast('Draft tersimpan'); });
  $('#fin').onclick = guard(async () => {
    if (!confirm('Finalisasi opname? Stok akan disesuaikan dan opname tidak dapat diubah lagi.')) return;
    await api('PUT', `/api/opname/${id}`, { lines: collect() });
    await api('POST', `/api/opname/${id}/finalisasi`); toast('Opname difinalisasi'); render();
  });
}

async function render() {
  const name = location.hash.slice(1).split('?')[0] || 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.hash.slice(1) === name));
  const el = $('#view'); el.onclick = null;
  try { await (views[name] || views.dashboard)(el); } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
addEventListener('hashchange', render);
render();
