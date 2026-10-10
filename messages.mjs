export const MESSAGE_SELECT = `SELECT m.id,m.user_id AS userId,u.name,m.text,m.created_at AS createdAt,
  u.color,u.avatar_version AS avatarVersion,m.reply_to_id AS replyToId,m.reply_to_user_id AS replyToUserId,
  original.id AS originalId,author.name AS originalName,original.text AS originalText
  FROM messages m JOIN users u ON u.id=m.user_id
  LEFT JOIN messages original ON original.id=m.reply_to_id
  LEFT JOIN users author ON author.id=original.user_id`;
export function messageRows(rows) {
  return rows.map(({ replyToId, replyToUserId, originalId, originalName, originalText, ...message }) => ({
    ...message,
    reply: replyToId == null ? null : { messageId: replyToId, userId: replyToUserId,
      available: originalId != null, name: originalName || null, text: originalText ?? null }
  }));
}
export function messageId(value, nullable = false) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw Object.assign(new Error('Invalid message ID.'), { status: 400 });
  return value;
}
export function afterId(value) {
  if (value == null) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Object.assign(new Error('Invalid reply cursor.'), { status: 400 });
  return Number(value);
}
