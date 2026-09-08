/* global document, navigator, history, location, window */
const $ = id => document.getElementById(id);
const zh = navigator.language.toLowerCase().startsWith('zh');
const words = zh ? { empty: '电脑端还没有可用会话。请先创建一个会话。', pairing: '请扫描电脑设置中的配对二维码。', paired: '设备已连接', failed: '连接失败，请检查电脑端 Lynn 和网络。', sending: '正在发送…', user: '你', assistant: 'Lynn', uploaded: '文件已添加', remove: '移除附件', offline: '当前离线，恢复网络后可继续。', secure: '添加到主屏幕需要 HTTPS；当前可在浏览器中使用。' } : { empty: 'Create a session on your computer to start.', pairing: 'Scan a pairing QR code from Lynn settings.', paired: 'Device connected', failed: 'Connection failed. Check Lynn on your computer and your network.', sending: 'Sending…', user: 'You', assistant: 'Lynn', uploaded: 'File attached', remove: 'Remove attachment', offline: 'Offline. Reconnect to continue.', secure: 'HTTPS is required to install this app. You can use it in this browser.' };
if (!zh) {
  document.documentElement.lang = 'en'; document.querySelector('.brand span').textContent = 'Continue anywhere'; document.querySelector('#pairing h1').textContent = 'Continue on your phone'; document.querySelector('#pairing p').textContent = 'Generate a pairing QR code in Lynn → Settings → Interface → Mobile access, then scan it.';
  document.querySelector('label[for="device-name"]').textContent = 'Device name'; $('device-name').placeholder = 'My phone'; document.querySelector('#pair-form button').textContent = 'Connect device'; document.querySelector('label[for="sessions"]').textContent = 'Session'; $('refresh').textContent = 'Refresh'; $('connection-note').textContent = 'The same conversation on your phone and computer.'; $('older').textContent = 'Older messages'; $('busy').textContent = 'Working… Approve tool requests on your computer if needed.'; document.querySelector('#files summary').textContent = 'Session files'; $('message').placeholder = 'Continue this conversation…'; document.querySelector('label[for="upload"]').firstChild.textContent = 'Add file'; $('upload-note').textContent = 'Up to 10 MB'; $('stop').textContent = 'Stop'; $('send').textContent = 'Send'; $('install').textContent = 'Install'; document.querySelector('footer').textContent = 'Connected to your own Lynn';
}
let pairCode = new URLSearchParams(location.hash.slice(1)).get('pair') || '';
history.replaceState(null, '', location.pathname);
let current = ''; let messages = []; let attached = []; let generation = 0; let sending = false; let refreshInFlight = false; let expandedHistory = false; let hasOlder = false;
const status = text => { $('status').textContent = text; };
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { $('workspace').hidden = true; $('pairing').hidden = false; pairCode = ''; throw new Error(words.pairing); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || words.failed); return data;
}
function renderMessages() {
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    if (!message.content) continue; const article = document.createElement('article'); article.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    const role = document.createElement('small'); role.textContent = message.role === 'user' ? words.user : words.assistant; const content = document.createElement('p'); content.textContent = message.content; article.append(role, content); fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
}
function renderAttachments() {
  $('attachments').replaceChildren(...attached.map(file => { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${file.name} ×`; button.setAttribute('aria-label', `${words.remove}: ${file.name}`); button.onclick = () => { attached = attached.filter(item => item.fileId !== file.fileId); renderAttachments(); }; return button; }));
}
async function refreshSession(older = false) {
  if (!current || (refreshInFlight && !older)) return;
  refreshInFlight = true; const id = current; const version = generation;
  try {
    const before = older && messages.length ? `?before=${encodeURIComponent(messages[0].id)}` : '';
    const [data, files] = await Promise.all([api(`/api/sessions/${id}/messages${before}`), api(`/api/session-files/${id}`)]);
    if (version !== generation) return;
    if (older) { messages = [...data.messages, ...messages]; expandedHistory = true; hasOlder = !!data.hasMore; }
    else if (!sending || data.messages.length) {
      const firstId = Number(data.messages[0]?.id || 0);
      messages = expandedHistory && data.hasMore ? [...messages.filter(message => Number(message.id) < firstId), ...data.messages] : data.messages;
      if (!expandedHistory) hasOlder = !!data.hasMore;
    }
    renderMessages(); $('older').hidden = !hasOlder; $('busy').hidden = !(data.busy || sending); $('stop').hidden = !data.busy; $('send').disabled = !!data.busy || sending;
    $('file-list').replaceChildren(...files.files.map(file => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = `/api/session-files/${id}/${encodeURIComponent(file.fileId)}`; a.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`; a.download = file.name; li.append(a); return li; }));
  } catch (error) { status(error.message || words.failed); }
  finally { refreshInFlight = false; }
}
async function loadSessions() {
  const data = await api('/api/sessions'); $('pairing').hidden = true; $('workspace').hidden = false;
  $('sessions').replaceChildren(...data.sessions.map(session => { const option = document.createElement('option'); option.value = session.id; option.textContent = session.title; return option; }));
  if (!data.sessions.some(session => session.id === current)) { current = data.sessions[0]?.id || ''; generation++; expandedHistory = false; hasOlder = false; messages = []; attached = []; $('message').value = ''; renderMessages(); renderAttachments(); }
  $('sessions').value = current; $('title').textContent = data.sessions.find(session => session.id === current)?.title || 'Lynn'; $('composer').hidden = !current;
  if (!current) status(words.empty); else { status(window.isSecureContext ? '' : words.secure); await refreshSession(); }
}
$('pair-form').onsubmit = async event => { event.preventDefault(); if (!pairCode) { status(words.pairing); return; } try { await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairCode, name: $('device-name').value || navigator.platform }) }); pairCode = ''; status(words.paired); await loadSessions(); } catch (error) { status(error.message); } };
$('sessions').onchange = async () => { current = $('sessions').value; generation++; expandedHistory = false; hasOlder = false; messages = []; attached = []; $('message').value = ''; renderMessages(); renderAttachments(); $('title').textContent = $('sessions').selectedOptions[0]?.textContent || 'Lynn'; await refreshSession(); };
$('refresh').onclick = () => loadSessions().catch(error => status(error.message)); $('older').onclick = () => refreshSession(true);
$('composer').onsubmit = async event => {
  event.preventDefault(); if (!current || sending) return; const text = $('message').value.trim(); if (!text) return; const id = current; const version = generation; const files = [...attached];
  sending = true; $('send').disabled = true; $('busy').hidden = false; status(words.sending);
  try {
    await api(`/api/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, fileIds: files.map(file => file.fileId) }) });
    if (generation === version) { $('message').value = ''; attached = []; renderAttachments(); status(''); }
  } catch (error) { status(error.message); }
  finally { sending = false; $('send').disabled = false; await refreshSession(); }
};
$('upload').onchange = async () => {
  const file = $('upload').files[0]; $('upload').value = ''; if (!file || !current) return; if (file.size > 10 * 1024 * 1024 || attached.length >= 9) { status(zh ? '最多 9 个附件，每个不超过 10 MB。' : 'Up to 9 attachments, 10 MB each.'); return; }
  const version = generation; const form = new FormData(); form.append('file', file);
  try { const result = await api(`/api/sessions/${current}/upload`, { method: 'POST', body: form }); if (generation === version) { attached.push(result); renderAttachments(); status(words.uploaded); } }
  catch (error) { status(error.message); }
};
$('stop').onclick = async () => { try { await api(`/api/sessions/${current}/abort`, { method: 'POST' }); await refreshSession(); } catch (error) { status(error.message); } };
window.addEventListener('offline', () => status(words.offline)); window.addEventListener('online', () => loadSessions().catch(error => status(error.message)));
setInterval(() => { if (!document.hidden && !$('workspace').hidden) void refreshSession(); }, 3000);
let installPrompt; window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; }); $('install').onclick = async () => { await installPrompt?.prompt(); $('install').hidden = true; };
if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => {});
if (!pairCode) loadSessions().catch(error => status(error.message));
