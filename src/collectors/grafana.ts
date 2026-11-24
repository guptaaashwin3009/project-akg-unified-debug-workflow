import { normalizeGrafanaBaseUrl } from "../auth/grafana.js";
import type { GrafanaCredentials } from "../auth/store.js";
import { CliError, GrafanaUnauthorizedError } from "../errors.js";
import type { Signal } from "../types.js";
import { splitStack } from "./datadog.js";

/** Same line cap as Kubernetes logs. Also the default Loki query_range limit. */
export const GRAFANA_LOG_LIMIT = 200;

const LEVEL_LABELS = ["detected_level", "level", "severity", "lvl", "log_level", "loglevel"];

export function isoToNanos(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new CliError(`Invalid time "${iso}".`);
  return (BigInt(ms) * 1_000_000n).toString();
}

export function nanosToIso(nanos: string): string {
  if (!/^\d+$/.test(nanos)) return new Date(0).toISOString();
  const ms = Number(BigInt(nanos) / 1_000_000n);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

/**
 * Loki query_range through the Grafana datasource proxy.
 * The LogQL query is sent unchanged. Callers should include their own error filter.
 */
export function buildGrafanaQueryRangeUrl(input: {
  baseUrl: string;
  datasourceUid: string;
  query: string;
  from: string;
  to: string;
  limit?: number;
}): string {
  const uid = input.datasourceUid.trim();
  if (!uid) throw new CliError("Grafana datasource UID is required.");
  const base = normalizeGrafanaBaseUrl(input.baseUrl);
  const params = new URLSearchParams({
    query: input.query.trim(),
    start: isoToNanos(input.from),
    end: isoToNanos(input.to),
    limit: String(input.limit ?? GRAFANA_LOG_LIMIT),
  });
  return `${base}/api/datasources/proxy/uid/${encodeURIComponent(uid)}/loki/api/v1/query_range?${params.toString()}`;
}

export function grafanaLokiHeaders(credentials: GrafanaCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.token}`,
  };
  const orgId = credentials.orgId?.trim();
  if (orgId) headers["X-Scope-OrgID"] = orgId;
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringLabels(value: Record<string, unknown> | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const coerced = asString(raw);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

function cappedAttributes(labels: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (Object.keys(out).length >= 20) break;
    out[key] = value.slice(0, 500);
  }
  return out;
}

function lineLooksLikeError(line: string): boolean {
  return /\b(error|fatal|panic|exception)\b/i.test(line);
}

function severityFrom(labels: Record<string, string>, line: string): string {
  for (const key of LEVEL_LABELS) {
    const value = labels[key]?.trim().toLowerCase();
    if (!value || value === "unknown" || value === "none") continue;
    if (["error", "err", "fatal", "critical", "panic", "emergency", "alert"].includes(value)) return "error";
    if (["warn", "warning"].includes(value)) return "warning";
    if (value === "info" || value === "information") return "info";
    return value;
  }
  if (lineLooksLikeError(line)) return "error";
  return "info";
}

function serviceFrom(labels: Record<string, string>, fallbackService: string): string {
  return labels.service || labels.app || labels.job || fallbackService;
}

export function signalsFromLokiResponse(payload: unknown, fallbackService: string): Signal[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const result = Array.isArray(data?.result) ? data.result : Array.isArray(root?.result) ? root.result : [];
  const signals: Signal[] = [];
  for (const item of result) {
    const stream = asRecord(item);
    const labels = stringLabels(asRecord(stream?.stream));
    const values = Array.isArray(stream?.values) ? stream.values : [];
    for (const value of values) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const line = asString(value[1]);
      if (!line) continue;
      const { message, stack } = splitStack(line);
      const timestamp = asString(value[0]);
      signals.push({
        source: "grafana",
        timestamp: timestamp ? nanosToIso(timestamp) : new Date(0).toISOString(),
        service: serviceFrom(labels, fallbackService),
        severity: severityFrom(labels, line),
        message: message.slice(0, 2000),
        stack,
        attributes: cappedAttributes(labels),
      });
    }
  }
  if (signals.length <= GRAFANA_LOG_LIMIT) return signals;
  return [...signals].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-GRAFANA_LOG_LIMIT);
}

export async function searchGrafanaLogs(
  credentials: GrafanaCredentials,
  input: { query: string; datasourceUid: string; from: string; to: string; service: string },
): Promise<Signal[]> {
  const url = buildGrafanaQueryRangeUrl({
    baseUrl: credentials.baseUrl,
    datasourceUid: input.datasourceUid,
    query: input.query,
    from: input.from,
    to: input.to,
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: grafanaLokiHeaders(credentials),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not search Grafana logs: ${message}`);
  }
  if (response.status === 401 || response.status === 403) throw new GrafanaUnauthorizedError();
  if (response.status === 404) {
    throw new CliError(
      `Grafana datasource "${input.datasourceUid}" was not found. Check the datasource UID and try again.`,
    );
  }
  if (!response.ok) throw new CliError(`Grafana log search failed with HTTP ${response.status}.`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("Grafana log search returned a response that was not JSON.");
  }
  const root = asRecord(payload);
  if (root?.status === "error") {
    const detail = asString(root.error)?.slice(0, 300);
    throw new CliError(detail ? `Grafana log query failed: ${detail}` : "Grafana log query failed.");
  }
  return signalsFromLokiResponse(payload, input.service);
}
