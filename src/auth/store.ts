import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../errors.js";

export interface DatadogCredentials {
  apiKey: string;
  appKey: string;
  site: string;
}

export interface LlmCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface GrafanaCredentials {
  baseUrl: string;
  token: string;
  orgId?: string;
}

export interface CredentialFile {
  datadog?: DatadogCredentials;
  grafana?: GrafanaCredentials;
  llm?: LlmCredentials;
  kube?: {
    context?: string;
  };
}

export function akgConfigDir(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".config", "akg-debug");
}

export function credentialsPath(): string {
  return path.join(akgConfigDir(), "credentials.json");
}

export function runsDir(): string {
  return path.join(akgConfigDir(), "runs");
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
}

/** Write a secret file and force mode 0600 even when umask is looser. */
export function writeSecretFile(filePath: string, contents: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, "w", 0o600);
  try {
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

export function loadCredentials(): CredentialFile {
  const filePath = credentialsPath();
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not read ${filePath}: ${message}`);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // The file is still usable if the mode cannot be tightened.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `Credentials file ${filePath} is not valid JSON. Fix or remove it, then run akg-debug auth again.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as CredentialFile;
}

export function saveCredentials(credentials: CredentialFile): void {
  writeSecretFile(
    credentialsPath(),
    `${JSON.stringify(credentials, null, 2)}\n`,
  );
}

export function updateCredentials(
  patch: Partial<CredentialFile>,
): CredentialFile {
  const current = loadCredentials();
  const next: CredentialFile = {
    ...current,
    ...patch,
  };
  if (patch.kube) {
    next.kube = { ...current.kube, ...patch.kube };
  }
  saveCredentials(next);
  return next;
}
