import fs from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import { ensurePrivateDir, runsDir, writeSecretFile } from "../auth/store.js";
import type { RunRecord } from "../types.js";

const RUN_ID = /^[A-Za-z0-9._-]+$/;

export function assertRunId(id: string): string {
  const trimmed = id.trim();
  if (!RUN_ID.test(trimmed)) {
    throw new CliError(`Run id "${id}" contains characters that are not allowed.`);
  }
  return trimmed;
}

export function runPath(id: string): string {
  return path.join(runsDir(), `${assertRunId(id)}.json`);
}

export function saveRun(record: RunRecord): void {
  assertRunId(record.id);
  ensurePrivateDir(runsDir());
  writeSecretFile(runPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export function loadRun(id: string): RunRecord {
  const filePath = runPath(id);
  if (!fs.existsSync(filePath)) {
    throw new CliError(`No saved run "${id}". Run \`akg-debug runs\` to list local runs.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new CliError(`Saved run ${filePath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliError(`Saved run ${filePath} is empty.`);
  }
  return parsed as RunRecord;
}

export function listRuns(): RunRecord[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];
  const records: RunRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RunRecord;
      if (parsed?.id) records.push(parsed);
    } catch {
      console.error(`Skipping unreadable run file ${name}.`);
    }
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return records;
}
