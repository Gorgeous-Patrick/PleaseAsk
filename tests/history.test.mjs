import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, decodeMessage, encodeMessage, mergeMessage, normalizeHistory } from '../web/history.mjs';

const at = '2026-10-27T12:00:00.000Z';
const message = (id, role, text, clock) => ({ id, role, text, clock, at });

test('reconnect replay fills divergent histories without duplicate bubbles', () => {
  const question = message('q', 'student', 'Can you explain this?', 1);
  const answer = message('a', 'teacher', 'Of course.', 2);
  const followUp = message('f', 'student', 'One more thing.', 3);
  const teacher = normalizeHistory([question, answer]);
  const student = normalizeHistory([question, followUp]);

  assert.deepEqual(mergeMessage(teacher, decodeMessage(encodeMessage(followUp), 'student')), { added: true, changed: true });
  assert.deepEqual(mergeMessage(student, decodeMessage(encodeMessage(answer), 'teacher')), { added: true, changed: true });
  assert.deepEqual(teacher.map(item => item.id), ['q', 'a', 'f']);
  assert.deepEqual(student.map(item => item.id), ['q', 'a', 'f']);

  assert.deepEqual(mergeMessage(teacher, followUp), { added: false, changed: false });
  assert.deepEqual(mergeMessage(student, answer), { added: false, changed: false });
  assert.equal(teacher.length, 3);
  assert.equal(student.length, 3);
});

test('older saved chat gets matching IDs on both browsers', () => {
  const previousTeacher = normalizeHistory([
    { role: 'student', text: 'Again?', at },
    { role: 'teacher', text: 'Yes.', at },
    { role: 'student', text: 'Again?', at },
  ]);
  const previousStudent = normalizeHistory([
    { role: 'student', text: 'Again?', at },
    { role: 'teacher', text: 'Yes.', at },
    { role: 'student', text: 'Again?', at },
  ]);
  assert.deepEqual(previousTeacher.map(item => item.id), previousStudent.map(item => item.id));
  assert.notEqual(previousTeacher[0].id, previousTeacher[2].id);
  for (const item of previousTeacher) mergeMessage(previousStudent, item);
  assert.equal(previousStudent.length, 3);
});

test('messages carry a causal clock and frame validation checks sender', () => {
  const previous = [message('q', 'student', 'Question', 17)];
  const reply = createMessage(previous, 'teacher', 'Reply');
  assert.equal(reply.clock, 18);
  assert.equal(decodeMessage(encodeMessage(reply), 'teacher')?.id, reply.id);
  assert.equal(decodeMessage(encodeMessage(reply), 'student'), null);
  assert.equal(decodeMessage('{bad json', 'teacher'), null);
  assert.equal(decodeMessage(encodeMessage({ ...reply, text: 'x'.repeat(4097) }), 'teacher'), null);
});

test('largest allowed text still fits one transport frame', () => {
  const outgoing = createMessage([], 'student', 'x'.repeat(4096));
  assert.ok(new TextEncoder().encode(encodeMessage(outgoing)).length < 32768);
  assert.throws(() => createMessage([], 'student', 'x'.repeat(4097)), /4096/);
});
