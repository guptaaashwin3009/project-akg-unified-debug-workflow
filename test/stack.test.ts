import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveFrames } from "../src/normalize/stack.js";

test("stack frame resolves to a repo-relative path", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "akg-debug-repo-"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "handler.ts"), "export function handleRequest() {}\n");

  const absolute = [
    "Error: connection refused",
    `    at handleRequest (${path.join(repo, "src", "handler.ts")}:10:4)`,
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");
  const fromCheckout = resolveFrames(absolute, repo);
  assert.equal(fromCheckout.length, 1);
  assert.equal(fromCheckout[0].file, "src/handler.ts");
  assert.equal(fromCheckout[0].line, 10);

  const fromContainer = ["Error: connection refused", "    at handleRequest (/app/src/handler.ts:22:3)"].join("\n");
  const fromImage = resolveFrames(fromContainer, repo);
  assert.equal(fromImage.length, 1);
  assert.equal(fromImage[0].file, "src/handler.ts");
  assert.equal(fromImage[0].line, 22);
});
