import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeDiff } from "../src/git/safety.js";

function diff(filePath: string): string {
  return [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`, "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
}

test("diff path safety rejects traversal, .git, and paths outside the allowlist", () => {
  assert.throws(() => assertSafeDiff(diff("../etc/passwd"), { allow: ["src/**"] }), /traversal|\.\./);
  assert.throws(() => assertSafeDiff(diff(".git/config"), { allow: ["**"] }), /\.git/);
  assert.throws(() => assertSafeDiff(diff("secrets/keys.ts"), { allow: ["src/**"] }), /allowlist/);
  assert.doesNotThrow(() => assertSafeDiff(diff("src/app.ts"), { allow: ["src/**"] }));
});
