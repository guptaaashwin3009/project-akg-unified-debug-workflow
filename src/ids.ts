import { randomBytes } from "node:crypto";

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
