export const ACTIVE_INVITE_KEY = 'pleaseask.active-invite.v1';
export const END_CLASS_FRAME = JSON.stringify({ type: 'end-class' });
export const END_ACK_FRAME = JSON.stringify({ type: 'end-class-ack' });

export function controlType(frame) {
  try {
    const type = JSON.parse(frame)?.type;
    return type === 'end-class' || type === 'end-class-ack' ? type : null;
  } catch {
    return null;
  }
}

export function clearTeacherStorage(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('pleaseask.')) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function clearStudentStorage(storage, teacherId) {
  const keys = [
    `pleaseask.student-key.v1.${teacherId}`,
    `pleaseask.student-key.v2.${teacherId}`,
    `pleaseask.student-key.v3.${teacherId}`,
    `pleaseask.student-history.v1.${teacherId}`,
    `pleaseask.student-conversation.v2.${teacherId}`,
    `pleaseask.student-conversation.v3.${teacherId}`,
  ];
  for (const key of keys) storage.removeItem(key);
}
