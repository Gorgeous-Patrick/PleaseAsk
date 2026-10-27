import init, { Student, Teacher } from './wasm/pleaseask.js';
import { createMessage, decodeMessage, encodeMessage, mergeMessage, normalizeHistory } from './history.mjs';
import { ACTIVE_INVITE_KEY, END_ACK_FRAME, END_CLASS_FRAME, clearStudentStorage, clearTeacherStorage, controlType } from './session.mjs';

const params = new URLSearchParams(location.search);
const isTeacher = params.has('teacher');
const $ = id => document.getElementById(id);

let teacher;
let student;
let inviteChannel;
let conversations = new Map();
let selectedPeer;
let teacherHistoryKey;
let studentMessages = [];
let studentHistoryKey;
let studentGeneration = 0;
let studentConnected = false;
let studentConnecting = false;
let endingClass = false;
let studentEnded = false;
const endAcknowledgements = new Map();

function storageKey(role, identity) {
  return `pleaseask.${role}.v3.${identity}`;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { alert('This conversation is visible now, but the browser could not save it for a reload. Check available storage.'); }
}

function getOrCreateKey(key) {
  let secret = localStorage.getItem(key);
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(key, secret);
  }
  return secret;
}

function status(text, connected = false) {
  $('connection-status').textContent = text;
  $('connection-status').classList.toggle('connected', connected);
}

function show(view) {
  for (const id of ['teacher-view', 'student-view', 'error-view', 'ended-view']) {
    $(id).hidden = id !== view;
  }
}

function showError(error) {
  $('error-message').textContent = String(error?.message || error);
  status('Offline');
  show('error-view');
}

function loadTeacherHistory(identity) {
  teacherHistoryKey = storageKey('teacher-conversations', identity);
  const current = readJson(teacherHistoryKey);
  const saved = Array.isArray(current) ? current : readJson(`pleaseask.teacher-conversations.v2.${identity}`);
  conversations = new Map();
  if (Array.isArray(saved)) {
    for (const item of saved) {
      if (typeof item?.peer !== 'string') continue;
      conversations.set(item.peer, {
        peer: item.peer,
        messages: normalizeHistory(item.messages),
        unread: Number.isSafeInteger(item.unread) && item.unread > 0 ? item.unread : 0,
        online: false,
      });
    }
    if (!Array.isArray(current)) persistTeacherHistory();
    return;
  }
  // Carry over conversations saved by the earlier Q&A interface.
  const old = readJson(`pleaseask.teacher-history.v1.${identity}`);
  if (Array.isArray(old)) {
    for (const item of old) {
      if (typeof item?.peer !== 'string' || typeof item.question !== 'string' || typeof item.answer !== 'string') continue;
      const chat = ensureConversation(item.peer);
      const at = typeof item.answeredAt === 'string' ? item.answeredAt : new Date().toISOString();
      chat.messages.push({ role: 'student', text: item.question, at });
      chat.messages.push({ role: 'teacher', text: item.answer, at });
    }
  }
  for (const chat of conversations.values()) chat.messages = normalizeHistory(chat.messages);
  persistTeacherHistory();
}

function persistTeacherHistory() {
  if (!teacherHistoryKey) return;
  saveJson(teacherHistoryKey, Array.from(conversations.values()).map(({ peer, messages, unread }) => ({ peer, messages, unread })));
}

function ensureConversation(peer) {
  let chat = conversations.get(peer);
  if (!chat) {
    chat = { peer, messages: [], unread: 0, online: false };
    conversations.set(peer, chat);
  }
  return chat;
}

function onPeer(peer, online) {
  if (endingClass) {
    if (online && teacher) void teacher.send(peer, END_CLASS_FRAME).catch(() => {});
    else endAcknowledgements.get(peer)?.();
    return;
  }
  const chat = ensureConversation(peer);
  chat.online = online;
  if (!selectedPeer) selectConversation(peer);
  else {
    renderThreadList();
    if (selectedPeer === peer) renderConversation();
  }
  persistTeacherHistory();
  if (online) void replayTeacherMessages(peer);
}

async function replayTeacherMessages(peer) {
  const messages = ensureConversation(peer).messages.filter(message => message.role === 'teacher');
  for (const message of messages) {
    if (endingClass || !ensureConversation(peer).online) break;
    try { await teacher.send(peer, encodeMessage(message)); }
    catch { break; }
  }
}

function onTeacherMessage(peer, frame) {
  if (controlType(frame) === 'end-class-ack') {
    endAcknowledgements.get(peer)?.();
    return;
  }
  if (endingClass) return;
  const message = decodeMessage(frame, 'student');
  if (!message) return;
  const chat = ensureConversation(peer);
  const { added, changed } = mergeMessage(chat.messages, message);
  if (!changed) return;
  if (added && (selectedPeer !== peer || document.visibilityState !== 'visible')) chat.unread++;
  if (!selectedPeer) selectConversation(peer);
  else {
    renderThreadList();
    if (selectedPeer === peer) renderConversation();
  }
  persistTeacherHistory();
}

function studentLabel(peer) {
  return `Student ${peer.slice(0, 8)}`;
}

function renderThreadList() {
  const list = $('thread-list');
  list.replaceChildren();
  const chats = Array.from(conversations.values()).sort((a, b) => {
    const aTime = a.messages.at(-1)?.at || '';
    const bTime = b.messages.at(-1)?.at || '';
    return bTime.localeCompare(aTime);
  });
  $('thread-count').textContent = `${chats.length} ${chats.length === 1 ? 'conversation' : 'conversations'}`;
  $('unread-count').textContent = chats.reduce((sum, chat) => sum + chat.unread, 0);
  if (chats.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-thread-list';
    empty.textContent = 'Students will appear here when they join.';
    list.append(empty);
    return;
  }
  for (const chat of chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-item${selectedPeer === chat.peer ? ' active' : ''}`;
    const top = document.createElement('div');
    top.className = 'thread-top';
    const name = document.createElement('span');
    name.className = 'thread-name';
    name.textContent = studentLabel(chat.peer);
    const presence = document.createElement('span');
    presence.className = `thread-presence${chat.online ? ' online' : ''}`;
    presence.textContent = chat.online ? 'Online' : 'Offline';
    top.append(name, presence);
    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.textContent = chat.messages.at(-1)?.text || 'Connected. Start a conversation.';
    button.append(top, preview);
    if (chat.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = chat.unread;
      button.append(badge);
    }
    button.addEventListener('click', () => selectConversation(chat.peer));
    list.append(button);
  }
}

function appendBubble(container, direction, text) {
  const row = document.createElement('div');
  row.className = `message ${direction}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(bubble);
  container.append(row);
  container.scrollTop = container.scrollHeight;
}

function selectConversation(peer) {
  if (selectedPeer !== peer) $('teacher-message').value = '';
  selectedPeer = peer;
  const chat = conversations.get(peer);
  if (!chat) return;
  chat.unread = 0;
  persistTeacherHistory();
  renderThreadList();
  renderConversation();
}

function renderConversation() {
  const chat = conversations.get(selectedPeer);
  $('conversation-empty').hidden = Boolean(chat);
  $('conversation-active').hidden = !chat;
  if (!chat) return;
  $('conversation-title').textContent = studentLabel(chat.peer);
  $('conversation-presence').textContent = chat.online ? 'Connected' : 'Offline · waiting for the student to reconnect';
  $('teacher-message').disabled = !chat.online;
  $('teacher-send').disabled = !chat.online;
  const messages = $('teacher-messages');
  messages.replaceChildren();
  for (const item of chat.messages) {
    appendBubble(messages, item.role === 'teacher' ? 'outgoing' : 'incoming', item.text);
  }
}

async function startTeacher() {
  status('Connecting to relay…');
  const earlyEvents = [];
  teacher = await Teacher.host(
    getOrCreateKey('pleaseask.teacher-key.v1'),
    (peer, text) => teacherHistoryKey ? onTeacherMessage(peer, text) : earlyEvents.push(['message', peer, text]),
    (peer, online) => teacherHistoryKey ? onPeer(peer, online) : earlyEvents.push(['peer', peer, online]),
  );
  const identity = teacher.endpoint_id();
  loadTeacherHistory(identity);
  for (const [type, peer, value] of earlyEvents) {
    if (type === 'message') onTeacherMessage(peer, value);
    else onPeer(peer, value);
  }
  renderThreadList();
  if (conversations.size > 0 && !selectedPeer) selectConversation(conversations.keys().next().value);

  const link = new URL(location.href);
  link.search = '';
  link.hash = '';
  link.searchParams.set('id', identity);
  link.searchParams.set('relay', teacher.relay_url());
  const joinLink = link.toString();
  localStorage.setItem(ACTIVE_INVITE_KEY, joinLink);
  $('join-link').value = joinLink;
  $('teacher-id').textContent = identity;
  const displayUrl = new URL('./invite.html', location.href);
  displayUrl.searchParams.set('join', joinLink);
  $('open-invite').href = displayUrl.toString();
  if ('BroadcastChannel' in window) {
    inviteChannel = new BroadcastChannel('pleaseask-invite-v1');
    inviteChannel.onmessage = event => {
      if (event.data?.type === 'request') inviteChannel.postMessage({ type: 'join', url: joinLink });
      if (event.data?.type === 'ended') void endTeacherClass({ remote: true });
    };
    inviteChannel.postMessage({ type: 'join', url: joinLink });
  }
  status('Listening', true);
  show('teacher-view');
  if (selectedPeer) renderConversation();
}

function loadStudentHistory(identity) {
  studentHistoryKey = storageKey('student-conversation', identity);
  const current = readJson(studentHistoryKey);
  if (Array.isArray(current)) return normalizeHistory(current);
  const saved = readJson(`pleaseask.student-conversation.v2.${identity}`);
  if (Array.isArray(saved)) {
    const migrated = normalizeHistory(saved);
    saveJson(studentHistoryKey, migrated);
    return migrated;
  }
  const old = readJson(`pleaseask.student-history.v1.${identity}`);
  const migrated = [];
  if (Array.isArray(old)) {
    for (const item of old) {
      if (typeof item?.question !== 'string' || typeof item.answer !== 'string') continue;
      const at = new Date().toISOString();
      migrated.push({ role: 'student', text: item.question, at });
      migrated.push({ role: 'teacher', text: item.answer, at });
    }
  }
  const normalized = normalizeHistory(migrated);
  saveJson(studentHistoryKey, normalized);
  return normalized;
}

function renderStudentMessages() {
  const messages = $('messages');
  messages.replaceChildren();
  for (const item of studentMessages) {
    appendBubble(messages, item.role === 'student' ? 'outgoing' : 'incoming', item.text);
  }
}

async function replayStudentMessages(client, generation) {
  const messages = studentMessages.filter(message => message.role === 'student');
  for (const message of messages) {
    if (generation !== studentGeneration || !studentConnected) break;
    try { await client.send(encodeMessage(message)); }
    catch { break; }
  }
}

function setStudentConnection(connected) {
  if (studentEnded) return;
  studentConnected = connected;
  status(connected ? 'Connected' : 'Disconnected', connected);
  $('question').disabled = !connected;
  $('send-button').disabled = !connected;
  $('student-reconnect').hidden = connected;
  $('student-note').textContent = connected ? 'Answers may take a moment.' : 'Reconnect to continue this conversation.';
}

async function connectStudent() {
  if (studentConnecting || studentEnded) return;
  studentConnecting = true;
  const generation = ++studentGeneration;
  setStudentConnection(false);
  status('Connecting…');
  try {
    if (student) {
      await student.close();
      student.free();
      student = undefined;
    }
    const id = params.get('id');
    const relay = params.get('relay');
    const key = getOrCreateKey(`pleaseask.student-key.v2.${id}`);
    const client = await Student.connect(
      id, relay, key,
      frame => {
        if (generation !== studentGeneration || studentEnded) return;
        if (controlType(frame) === 'end-class') {
          void endStudentClass();
          return;
        }
        const message = decodeMessage(frame, 'teacher');
        if (!message || !mergeMessage(studentMessages, message).changed) return;
        renderStudentMessages();
        saveJson(studentHistoryKey, studentMessages);
      },
      () => { if (generation === studentGeneration && !studentEnded) setStudentConnection(false); },
    );
    if (studentEnded) {
      await client.close();
      client.free();
      return;
    }
    student = client;
    setStudentConnection(true);
    void replayStudentMessages(client, generation);
  } catch (error) {
    if (studentEnded) return;
    setStudentConnection(false);
    $('student-note').textContent = `Could not connect: ${String(error?.message || error)}. Try again or scan the latest QR code.`;
  } finally {
    studentConnecting = false;
  }
}

async function startStudent() {
  const id = params.get('id');
  const relay = params.get('relay');
  if (!id || !relay) throw new Error('Scan the QR code shown by your teacher to join.');
  studentMessages = loadStudentHistory(id);
  show('student-view');
  renderStudentMessages();
  await connectStudent();
  if (studentConnected) $('question').focus();
}

function showEndedPage() {
  status('Off');
  $('ended-title').textContent = 'Class ended';
  $('ended-message').textContent = isTeacher
    ? 'Class chats and keys were erased from this browser. The Iroh endpoint is off.'
    : 'Your teacher ended this class. Scan a new invitation to join the next one.';
  $('start-new-class').hidden = !isTeacher;
  show('ended-view');
}

async function endStudentClass() {
  if (studentEnded) return;
  studentEnded = true;
  studentGeneration++;
  studentConnected = false;
  history.replaceState(null, '', `${location.pathname}${location.search}#ended`);
  showEndedPage();
  clearStudentStorage(localStorage, params.get('id'));
  studentHistoryKey = undefined;
  studentMessages = [];
  $('messages').replaceChildren();
  try { await student?.send(END_ACK_FRAME); } catch { /* The teacher may already have disconnected. */ }
  try { await student?.close(); } catch { /* Clear this class even if close fails. */ }
  student = undefined;
}

async function endTeacherClass({ remote = false } = {}) {
  if (endingClass || !teacher || (!remote && !confirm('End this class? This closes the Iroh connection and erases all Please Ask data in this browser. Connected students will also be asked to clear this class.'))) return;
  endingClass = true;
  $('end-class').disabled = true;
  status('Ending class…');
  const peers = Array.from(conversations.values()).filter(chat => chat.online).map(chat => chat.peer);
  const acknowledgements = peers.map(peer => new Promise(resolve => {
    endAcknowledgements.set(peer, resolve);
    void teacher.send(peer, END_CLASS_FRAME).catch(resolve);
  }));
  await Promise.race([
    Promise.all(acknowledgements),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  endAcknowledgements.clear();
  try { await teacher.stop(); } catch { /* Still erase local class data. */ }
  teacher = undefined;
  clearTeacherStorage(localStorage);
  inviteChannel?.postMessage({ type: 'ended' });
  inviteChannel?.close();
  inviteChannel = undefined;
  conversations = new Map();
  selectedPeer = undefined;
  teacherHistoryKey = undefined;
  $('join-link').value = '';
  $('open-invite').removeAttribute('href');
  history.replaceState(null, '', `${location.pathname}?teacher#ended`);
  showEndedPage();
}

$('teacher-form').addEventListener('submit', async event => {
  event.preventDefault();
  const peer = selectedPeer;
  const input = $('teacher-message');
  const text = input.value.trim();
  if (!peer || !text || !teacher || endingClass) return;
  let message;
  try {
    const chat = ensureConversation(peer);
    message = createMessage(chat.messages, 'teacher', text);
    mergeMessage(chat.messages, message);
    persistTeacherHistory();
    if (selectedPeer === peer) {
      input.value = '';
      renderConversation();
    }
    renderThreadList();
  } catch (error) {
    alert(String(error?.message || error));
    return;
  }
  try {
    await teacher.send(peer, encodeMessage(message));
  } catch {
    alert('Message saved here. It will be sent when this student reconnects.');
  }
});

$('ask-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('question');
  const text = input.value.trim();
  if (!text || !student || !studentConnected || studentEnded) return;
  let message;
  try {
    message = createMessage(studentMessages, 'student', text);
    mergeMessage(studentMessages, message);
    renderStudentMessages();
    saveJson(studentHistoryKey, studentMessages);
    input.value = '';
  } catch (error) {
    alert(String(error?.message || error));
    return;
  }
  try {
    await student.send(encodeMessage(message));
  } catch {
    alert('Message saved here. Reconnect to send it to your teacher.');
  }
});

for (const [field, form] of [['question', 'ask-form'], ['teacher-message', 'teacher-form']]) {
  $(field).addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $(form).requestSubmit();
    }
  });
}

$('student-reconnect').addEventListener('click', connectStudent);
$('end-class').addEventListener('click', () => void endTeacherClass());
$('start-new-class').addEventListener('click', () => location.replace('?teacher'));
$('copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('join-link').value);
  $('copy-link').textContent = 'Copied';
  setTimeout(() => $('copy-link').textContent = 'Copy', 1800);
});
$('retry-button').addEventListener('click', () => location.reload());
document.addEventListener('visibilitychange', () => {
  if (isTeacher && document.visibilityState === 'visible' && selectedPeer) {
    selectConversation(selectedPeer);
  }
});

if (location.hash === '#ended') {
  showEndedPage();
} else {
  try {
    await init();
    if (isTeacher) await startTeacher();
    else await startStudent();
  } catch (error) {
    showError(error);
  }
}
