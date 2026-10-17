'use strict';
const $ = id => document.getElementById(id);
let records = [];
let paused = false;
let loading = false;
let refreshPending = false;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'Расширение не отвечает');
  return result;
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}
function filtered() {
  const query = $('search').value.trim().toLowerCase();
  const rows = records.filter(record => record.domain.includes(query));
  return rows.sort((a, b) => {
    if ($('sort').value === 'name') return a.domain.localeCompare(b.domain);
    if ($('sort').value === 'count') return b.count - a.count || a.domain.localeCompare(b.domain);
    return b.lastSeen.localeCompare(a.lastSeen) || a.domain.localeCompare(b.domain);
  });
}
function render() {
  const rows = filtered();
  $('summary').textContent = `${records.length} доменов · ${records.reduce((sum, row) => sum + row.directCount, 0)} посещений · ${records.reduce((sum, row) => sum + row.indirectCount, 0)} фоновых обращений${paused ? ' · пауза' : ''}`;
  $('pause').textContent = paused ? 'Возобновить сбор' : 'Приостановить сбор';
  $('list').replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = records.length ? 'По этому запросу ничего нет.' : 'Откройте сайт после установки, и здесь появится его домен.';
    $('list').append(empty);
  }
  for (const row of rows) {
    const item = document.createElement('div'); item.className = 'record';
    const left = document.createElement('div');
    const domain = document.createElement('div'); domain.className = 'domain'; domain.textContent = row.domain;
    const date = document.createElement('div'); date.className = 'date'; date.textContent = new Date(row.lastSeen).toLocaleString('ru-RU');
    const counts = document.createElement('div'); counts.className = 'date';
    counts.textContent = `Посещений: ${row.directCount} · Фоновых: ${row.indirectCount}`;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = row.count;
    count.title = 'Всего посещений и фоновых обращений';
    left.append(domain, counts, date); item.append(left, count); $('list').append(item);
  }
  for (const id of ['txt', 'csv', 'json']) $(id).disabled = !rows.length;
  $('clear').disabled = !records.length;
  $('pause').disabled = false;
}
async function refresh() {
  if (loading) { refreshPending = true; return; }
  loading = true;
  try {
    const data = await request({type: 'snapshot'});
    records = data.records; paused = data.paused;
    $('error').hidden = !data.error; $('error').textContent = data.error;
    render();
  } catch (error) { showError(error); } finally {
    loading = false;
    if (refreshPending) { refreshPending = false; void refresh(); }
  }
}
function download(format) {
  const rows = filtered();
  let text, type;
  if (format === 'txt') { text = rows.map(row => row.domain).join('\n') + '\n'; type = 'text/plain'; }
  if (format === 'json') { text = JSON.stringify(rows, null, 2); type = 'application/json'; }
  if (format === 'csv') {
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    text = '\ufeff' + ['domain,count,direct_count,indirect_count,first_seen,last_seen', ...rows.map(row => [row.domain, row.count, row.directCount, row.indirectCount, row.firstSeen, row.lastSeen].map(quote).join(','))].join('\r\n'); type = 'text/csv';
  }
  const url = URL.createObjectURL(new Blob([text], {type: type + ';charset=utf-8'}));
  const link = document.createElement('a'); link.href = url;
  link.download = `domains-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('pause').addEventListener('click', async () => {
  $('pause').disabled = true;
  try { await request({type: 'pause', value: !paused}); await refresh(); }
  catch (error) { showError(error); } finally { $('pause').disabled = false; }
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Удалить весь список доменов? Сначала сохраните экспорт, если он вам нужен.')) return;
  try { await request({type: 'clear'}); await refresh(); } catch (error) { showError(error); }
});
for (const id of ['txt', 'csv', 'json']) $(id).addEventListener('click', () => download(id));
$('search').addEventListener('input', render);
$('sort').addEventListener('change', render);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') void refresh(); });
void refresh();
