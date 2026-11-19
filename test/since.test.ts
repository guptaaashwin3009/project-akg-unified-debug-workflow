import assert from "node:assert/strict";
import test from "node:test";
import { parseSince } from "../src/config.js";

test("since-window parsing supports 1h, 30m, and 2d", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const hour = parseSince("1h", now);
  const minutes = parseSince("30m", now);
  const days = parseSince("2d", now);

  assert.equal(hour.to, "2026-01-01T00:00:00.000Z");
  assert.equal(hour.from, "2025-12-31T23:00:00.000Z");
  assert.equal(minutes.from, "2025-12-31T23:30:00.000Z");
  assert.equal(days.from, "2025-12-30T00:00:00.000Z");
  assert.equal(hour.durationMs, 3_600_000);
  assert.equal(minutes.durationMs, 1_800_000);
  assert.equal(days.durationMs, 172_800_000);
});
