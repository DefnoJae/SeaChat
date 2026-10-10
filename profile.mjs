export const COLORS = ['#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#fb923c', '#22d3ee'];
export const REASONS = ['Spam', 'Harassment', 'Spoilers', 'Other'];
function reject(message) { throw Object.assign(new Error(message), { status: 400 }); }
export function validateProfile(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(name)) reject('Use a name of 2–24 letters, numbers, spaces, underscores or hyphens.');
  if (!COLORS.includes(data.color)) reject('Choose one of the available name colors.');
  const avatar = data.avatar;
  if (typeof avatar !== 'string' || avatar.length > 32768) reject('Profile picture must be a small image (24 KB maximum).');
  if (avatar) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
    if (!match || match[2].length % 4) reject('Use a JPEG, PNG or WebP profile picture.');
    let bytes;
    try { bytes = atob(match[2]); } catch { reject('Invalid image.'); }
    const valid = match[1] === 'jpeg' ? bytes.startsWith('\xff\xd8\xff')
      : match[1] === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
    if (!valid || bytes.length > 24576) reject('Invalid or oversized image.');
  }
  return { name, color: data.color, avatar };
}
export function validateReport(data) {
  const reason = data.reason || 'Other';
  const details = typeof data.details === 'string' ? data.details.trim() : '';
  if (!REASONS.includes(reason) || details.length > 1000) reject('Choose a report reason and use at most 1000 characters of details.');
  return { reason, details };
}
