'use strict';

// Serialize reads and mutations so parallel tabs cannot overwrite a visit.
let pending = Promise.resolve();
let domainCount = 0;
let collectionPaused = false;
let storageError = false;
function enqueue(task) {
  const result = pending.then(task);
  pending = result.catch(() => {});
  return result;
}

function badgeNumber(count) {
  if (count < 10000) return String(count);
  if (count < 1000000) return Math.floor(count / 1000) + 'k';
  return Math.floor(count / 1000000) + 'm';
}

async function updateBadge() {
  const state = storageError ? ' · ошибка сохранения' : collectionPaused ? ' · сбор на паузе' : '';
  await chrome.action.setBadgeBackgroundColor({color: storageError ? '#b42318' : collectionPaused ? '#637082' : '#1d6258'});
  await chrome.action.setBadgeText({text: badgeNumber(domainCount)});
  await chrome.action.setTitle({title: `Мои домены: ${domainCount} уникальных доменов${state}`});
}

async function reportError(error) {
  console.error('Domain collector:', error);
  storageError = true;
  try { await updateBadge(); } catch (_) {}
  try { await chrome.storage.local.set({lastError: 'Не удалось сохранить данные. Экспортируйте список и проверьте свободное место.'}); } catch (_) {}
}

function normalizeRecord(record) {
  // Version 1.0 stored only direct visits. Keep existing data on update.
  return {...record, directCount: record.directCount ?? record.count, indirectCount: record.indirectCount ?? 0};
}

// Restore on every worker start, including browser restart and update.
// Queue this read before new events to avoid counting stored domains twice.
void enqueue(async () => {
  const data = await chrome.storage.local.get(null);
  domainCount = Object.keys(data).filter(key => key.startsWith('domain:')).length;
  collectionPaused = !!data.paused;
  storageError = !!data.lastError;
  await updateBadge();
}).catch(reportError);

function recordInteraction(details, kind) {
  let url;
  try { url = new URL(details.url); } catch (_) { return; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
  const domain = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!domain) return;
  const time = new Date(details.timeStamp).toISOString();
  void enqueue(async () => {
    const key = 'domain:' + domain;
    const data = await chrome.storage.local.get(['paused', key]);
    if (data.paused) return;
    const previous = data[key];
    const record = previous ? normalizeRecord(previous) : {domain, count: 0, directCount: 0, indirectCount: 0, firstSeen: time, lastSeen: time};
    await chrome.storage.local.set({[key]: {
      domain, count: record.count + 1,
      directCount: record.directCount + (kind === 'direct' ? 1 : 0),
      indirectCount: record.indirectCount + (kind === 'indirect' ? 1 : 0),
      firstSeen: record.firstSeen < time ? record.firstSeen : time,
      lastSeen: record.lastSeen > time ? record.lastSeen : time
    }});
    if (!previous) {
      domainCount += 1;
      await updateBadge();
    }
  }).catch(reportError);
}

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return;
  recordInteraction(details, 'direct');
});

// Observe request starts, without reading bodies/headers or modifying requests.
// Main documents use onCommitted above, avoiding a duplicate direct count.
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || details.type === 'main_frame') return;
  recordInteraction(details, 'indirect');
}, {urls: ['<all_urls>']});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void enqueue(async () => {
    if (message.type === 'snapshot') {
      const data = await chrome.storage.local.get(null);
      return {
        paused: !!data.paused, error: data.lastError || '',
        records: Object.entries(data).filter(([key]) => key.startsWith('domain:')).map(([, value]) => normalizeRecord(value))
      };
    }
    if (message.type === 'pause' && typeof message.value === 'boolean') {
      await chrome.storage.local.set({paused: message.value});
      collectionPaused = message.value;
      await updateBadge();
      return {};
    }
    if (message.type === 'clear') {
      const data = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(data).filter(key => key.startsWith('domain:') || key === 'lastError'));
      domainCount = 0;
      storageError = false;
      await updateBadge();
      return {};
    }
    throw new Error('Неизвестная команда');
  }).then(value => sendResponse({ok: true, ...value}), error => sendResponse({ok: false, error: error.message}));
  return true;
});
