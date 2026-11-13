// One rule for whose text may drive the engine (a shell for the seats, a reply, a code edit):
// the viewer, or an author with write or admin access to the repo. The org association MEMBER is
// not write access, so it never counts. A bot ([bot] login) is never trusted, also with write access: it can
// relay text from anyone. A failed permission call counts as untrusted, so the caller runs read-only.
const WRITE = new Set(["write", "admin"]);

/** -> a function login => Promise<boolean>; it asks gh.permission once per login. */
export function canDrive(gh, repo, me) {
  const seen = new Map();
  return (login) => {
    if (!login) return Promise.resolve(false);
    if (login === me) return Promise.resolve(true);
    if (/\[bot\]$/i.test(login)) return Promise.resolve(false);
    if (!seen.has(login)) seen.set(login, gh.permission(repo, login).then((p) => WRITE.has(p), () => false));
    return seen.get(login);
  };
}
