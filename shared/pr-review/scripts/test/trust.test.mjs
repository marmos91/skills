import test from "node:test";
import assert from "node:assert/strict";
import { canDrive } from "../lib/trust.mjs";

test("canDrive: the viewer and write/admin; never MEMBER-only, a bot or a failed call; one call per login", async () => {
  const calls = [];
  const perms = { w: "write", a: "admin", r: "read", "dependabot[bot]": "write" };
  const gh = { permission: async (_r, l) => { calls.push(l); if (l === "boom") throw new Error("HTTP 502"); return perms[l] ?? "none"; } };
  const ok = canDrive(gh, "o/r", "me");
  for (const [l, want] of [["me", true], ["w", true], ["a", true], ["r", false], ["x", false], [null, false], ["dependabot[bot]", false], ["boom", false], ["w", true]]) assert.equal(await ok(l), want, String(l));
  assert.deepEqual(calls, ["w", "a", "r", "x", "boom"]);
});
