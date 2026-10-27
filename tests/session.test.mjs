import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_INVITE_KEY, END_ACK_FRAME, END_CLASS_FRAME, clearStudentStorage, clearTeacherStorage, controlType } from '../web/session.mjs';

function storage(initial) {
  const items = new Map(Object.entries(initial));
  return {
    get length() { return items.size; },
    key(index) { return Array.from(items.keys())[index] ?? null; },
    getItem(key) { return items.get(key) ?? null; },
    removeItem(key) { items.delete(key); },
  };
}

test('end-class control frames are distinct from chat messages', () => {
  assert.equal(controlType(END_CLASS_FRAME), 'end-class');
  assert.equal(controlType(END_ACK_FRAME), 'end-class-ack');
  assert.equal(controlType('{"type":"message"}'), null);
  assert.equal(controlType('{bad json'), null);
});

test('ending a class erases app data and its active QR, preserving unrelated site data', () => {
  const browser = storage({
    'pleaseask.teacher-key.v1': 'secret',
    'pleaseask.teacher-conversations.v3.id': '[...]',
    [ACTIVE_INVITE_KEY]: 'https://example.test/?id=old',
    'other-app.preference': 'keep',
  });
  clearTeacherStorage(browser);
  assert.equal(browser.length, 1);
  assert.equal(browser.getItem('other-app.preference'), 'keep');
  assert.equal(browser.getItem(ACTIVE_INVITE_KEY), null);
});

test('student cleanup removes only the ended teacher session', () => {
  const browser = storage({
    'pleaseask.student-key.v2.teacher-a': 'secret-a',
    'pleaseask.student-conversation.v3.teacher-a': '[...]',
    'pleaseask.student-conversation.v2.teacher-a': '[...]',
    'pleaseask.student-history.v1.teacher-a': '[...]',
    'pleaseask.student-key.v2.teacher-b': 'secret-b',
    'pleaseask.student-conversation.v3.teacher-b': '[...]',
  });
  clearStudentStorage(browser, 'teacher-a');
  assert.equal(browser.getItem('pleaseask.student-key.v2.teacher-a'), null);
  assert.equal(browser.getItem('pleaseask.student-conversation.v3.teacher-a'), null);
  assert.equal(browser.getItem('pleaseask.student-conversation.v2.teacher-a'), null);
  assert.equal(browser.getItem('pleaseask.student-history.v1.teacher-a'), null);
  assert.equal(browser.getItem('pleaseask.student-key.v2.teacher-b'), 'secret-b');
  assert.equal(browser.getItem('pleaseask.student-conversation.v3.teacher-b'), '[...]');
});
