/** Distinguish identical shared profile names without exposing account or device identifiers. */
export function v2MemberLabels(members: readonly { userId: string; displayName: string }[]) {
  const byName = new Map<string, string[]>();
  for (const member of members) { const users = byName.get(member.displayName) ?? []; users.push(member.userId); byName.set(member.displayName, users); }
  const labels = new Map<string, string>();
  for (const [name, users] of byName) {
    const sorted = [...new Set(users)].sort();
    for (let index = 0; index < sorted.length; index++) labels.set(sorted[index], sorted.length > 1 ? `${name}（${index + 1}）` : name);
  }
  return (uid: string) => labels.get(uid) ?? '以前のメンバー';
}
