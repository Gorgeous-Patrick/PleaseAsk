import init, { qr_svg } from './wasm/pleaseask.js?v=ios-relay-1';
import { ACTIVE_INVITE_KEY } from './session.mjs';

const qr = document.getElementById('qr');
const initialJoinLink = new URLSearchParams(location.search).get('join');

await init({ module_or_path: new URL('./wasm/pleaseask_bg.wasm?v=ios-relay-1', import.meta.url) });

function showInvitation(url) {
  if (typeof url !== 'string') return;
  if (localStorage.getItem(ACTIVE_INVITE_KEY) !== url) return;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== location.origin) return;
    if (!parsed.searchParams.has('id') || !parsed.searchParams.has('relay')) return;
    qr.innerHTML = qr_svg(parsed.toString());
  } catch {
    qr.replaceChildren();
  }
}

function showEnded() {
  qr.textContent = 'Class ended';
  history.replaceState(null, '', location.pathname);
}

if (initialJoinLink && localStorage.getItem(ACTIVE_INVITE_KEY) === initialJoinLink) showInvitation(initialJoinLink);
else if (localStorage.getItem(ACTIVE_INVITE_KEY)) showInvitation(localStorage.getItem(ACTIVE_INVITE_KEY));
else showEnded();

if ('BroadcastChannel' in window) {
  const channel = new BroadcastChannel('pleaseask-invite-v1');
  channel.onmessage = event => {
    if (event.data?.type === 'join') showInvitation(event.data.url);
    if (event.data?.type === 'ended') showEnded();
  };
  channel.postMessage({ type: 'request' });
}

window.addEventListener('storage', event => {
  if (event.key === ACTIVE_INVITE_KEY && !event.newValue) showEnded();
});
