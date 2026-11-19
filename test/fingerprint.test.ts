import assert from "node:assert/strict";
import test from "node:test";
import { fingerprint, groupFingerprints } from "../src/normalize/fingerprint.js";

test("fingerprint strips ids, numbers, hex, and timestamps and groups equal templates", () => {
  const first =
    "failed request id 3f1c9c2e-1b4a-4d2e-9c3a-112233445566 user 42 at 2026-01-01T00:00:00Z token deadbeefcafebabe";
  const second =
    "failed request id 11111111-2222-4333-8444-555555555555 user 99 at 2026-02-02T01:02:03.123Z token 0123456789abcdef";
  const other = "disk full while writing snapshot";

  const template = fingerprint(first);
  assert.equal(template, fingerprint(second));
  assert.equal(template.includes("3f1c9c2e"), false);
  assert.equal(template.includes("42"), false);
  assert.equal(template.includes("99"), false);
  assert.equal(template.includes("deadbeefcafebabe"), false);
  assert.equal(template.includes("2026-01-01"), false);
  assert.match(template, /<id>/);
  assert.match(template, /<n>/);
  assert.match(template, /<ts>/);
  assert.match(template, /<hex>/);

  const groups = groupFingerprints([first, second, other, first]);
  assert.equal(groups[0].template, template);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[1].count, 1);
  assert.equal(groups.length, 2);
});
