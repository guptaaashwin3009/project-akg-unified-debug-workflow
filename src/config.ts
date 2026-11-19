import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError } from "./errors.js";

export interface TeamConfig {
  service?: string;
  datadog?: {
    query?: string;
  };
  k8s?: {
    namespace?: string;
    selector?: string;
  };
  github?: {
    deployWorkflow?: string;
    deployRef?: string;
    workflowInputs?: Record<string, string>;
  };
  patch?: {
    allow?: string[];
  };
}

export interface ResolvedInvestigateConfig {
  repo: string;
  since: string;
  service: string;
  namespace: string;
  query: string;
  selector: string;
  allow?: string[];
  deployWorkflow?: string;
  deployRef?: string;
  workflowInputs?: Record<string, string>;
}

const SINCE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseSince(since: string, now = Date.now()): { from: string; to: string; durationMs: number } {
  const match = /^(\d+)([mhd])$/.exec(since.trim());
  if (!match) {
    throw new CliError(`Invalid --since value "${since}". Use a window like 30m, 1h, or 2d.`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CliError(`Invalid --since value "${since}". Use a positive window like 30m, 1h, or 2d.`);
  }
  const durationMs = amount * SINCE_UNITS[match[2]];
  return {
    from: new Date(now - durationMs).toISOString(),
    to: new Date(now).toISOString(),
    durationMs,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const coerced = asString(raw);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(asString).filter((item): item is string => Boolean(item));
  return items;
}

export function loadTeamConfig(repo: string): TeamConfig {
  const filePath = path.join(repo, ".akg-debug.yml");
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not parse ${filePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${filePath} must be a YAML mapping.`);
  }
  const raw = parsed as Record<string, unknown>;
  const datadog = raw.datadog && typeof raw.datadog === "object" ? (raw.datadog as Record<string, unknown>) : undefined;
  const k8s = raw.k8s && typeof raw.k8s === "object" ? (raw.k8s as Record<string, unknown>) : undefined;
  const github = raw.github && typeof raw.github === "object" ? (raw.github as Record<string, unknown>) : undefined;
  const patch = raw.patch && typeof raw.patch === "object" ? (raw.patch as Record<string, unknown>) : undefined;

  return {
    service: asString(raw.service),
    datadog: datadog ? { query: asString(datadog.query) } : undefined,
    k8s: k8s ? { namespace: asString(k8s.namespace), selector: asString(k8s.selector) } : undefined,
    github: github
      ? {
          deployWorkflow: asString(github.deployWorkflow),
          deployRef: asString(github.deployRef),
          workflowInputs: asStringMap(github.workflowInputs),
        }
      : undefined,
    patch: patch ? { allow: asStringList(patch.allow) } : undefined,
  };
}

export function resolveInvestigateConfig(
  repo: string,
  flags: {
    since?: string;
    service?: string;
    namespace?: string;
    query?: string;
  },
  team: TeamConfig,
): ResolvedInvestigateConfig {
  const service = flags.service?.trim() || team.service;
  const namespace = flags.namespace?.trim() || team.k8s?.namespace;
  const query = flags.query?.trim() || team.datadog?.query;
  const missing: string[] = [];
  if (!service) missing.push("--service");
  if (!namespace) missing.push("--namespace");
  if (!query) missing.push("--query");
  if (missing.length) {
    throw new CliError(
      `Missing ${missing.join(", ")}. Pass those flags or add them to ${path.join(repo, ".akg-debug.yml")}.`,
    );
  }
  return {
    repo,
    since: flags.since?.trim() || "1h",
    service: service as string,
    namespace: namespace as string,
    query: query as string,
    selector: team.k8s?.selector || `app=${service}`,
    allow: team.patch?.allow,
    deployWorkflow: team.github?.deployWorkflow,
    deployRef: team.github?.deployRef,
    workflowInputs: team.github?.workflowInputs,
  };
}
