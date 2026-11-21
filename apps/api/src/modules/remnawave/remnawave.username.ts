// Username в Remnawave: 3-36 символов, буквы/цифры/_/-. Делаем его детерминированным от нашего
// user.id: повторная попытка создать пользователя находит уже созданного и не плодит дубли.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function remnawaveUsernameFor(userId: string): string {
  if (!UUID_RE.test(userId)) throw new Error("user id must be a UUID");
  return `vs_${userId.replaceAll("-", "").toLowerCase()}`; // 3 + 32 = 35 символов
}
