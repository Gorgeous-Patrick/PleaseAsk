const MAX_MESSAGE_BYTES = 4096;
const encoder = new TextEncoder();

function validMessage(message) {
  return message && typeof message === 'object'
    && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
    && (message.role === 'student' || message.role === 'teacher')
    && typeof message.text === 'string' && message.text.trim().length > 0
    && encoder.encode(message.text).length <= MAX_MESSAGE_BYTES
    && Number.isSafeInteger(message.clock) && message.clock > 0
    && typeof message.at === 'string' && message.at.length <= 64;
}

function legacyId(role, text, occurrence) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(JSON.stringify([role, text, occurrence]))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `legacy-${hash.toString(16).padStart(16, '0')}`;
}

export function mergeMessage(messages, message) {
  if (!validMessage(message)) return { added: false, changed: false };
  const existing = messages.find(item => item.id === message.id);
  if (existing) {
    if (existing.id.startsWith('legacy-') && existing.role === message.role && existing.text === message.text && message.clock < existing.clock) {
      existing.clock = message.clock;
      messages.sort(compareMessages);
      return { added: false, changed: true };
    }
    return { added: false, changed: false };
  }
  messages.push({ id: message.id, role: message.role, text: message.text, clock: message.clock, at: message.at });
  messages.sort(compareMessages);
  return { added: true, changed: true };
}

function compareMessages(a, b) {
  return a.clock - b.clock || a.id.localeCompare(b.id);
}

export function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const messages = [];
  const occurrences = new Map();
  for (const [index, item] of value.entries()) {
    if (!item || (item.role !== 'student' && item.role !== 'teacher') || typeof item.text !== 'string') continue;
    const occurrenceKey = JSON.stringify([item.role, item.text]);
    const occurrence = (occurrences.get(occurrenceKey) || 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const message = {
      id: typeof item.id === 'string' ? item.id : legacyId(item.role, item.text, occurrence),
      role: item.role,
      text: item.text,
      clock: Number.isSafeInteger(item.clock) && item.clock > 0 ? item.clock : index + 1,
      at: typeof item.at === 'string' ? item.at : '',
    };
    mergeMessage(messages, message);
  }
  return messages;
}

export function createMessage(messages, role, text) {
  if (typeof text !== 'string' || !text.trim() || encoder.encode(text).length > MAX_MESSAGE_BYTES) {
    throw new Error('Message must be 1–4096 bytes.');
  }
  const clock = messages.reduce((max, item) => Math.max(max, item.clock), 0) + 1;
  if (!Number.isSafeInteger(clock)) throw new Error('Conversation clock is full.');
  return { id: crypto.randomUUID(), role, text, clock, at: new Date().toISOString() };
}

export function encodeMessage(message) {
  return JSON.stringify({ type: 'message', message });
}

export function decodeMessage(frame, senderRole) {
  try {
    const wire = JSON.parse(frame);
    if (wire?.type !== 'message' || !validMessage(wire.message) || wire.message.role !== senderRole) return null;
    return wire.message;
  } catch {
    return null;
  }
}
