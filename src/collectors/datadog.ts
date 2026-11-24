import { CliError, DatadogUnauthorizedError } from "../errors.js";
import type { DatadogCredentials } from "../auth/store.js";
import { datadogApiBase } from "../auth/datadog.js";
import type { Signal } from "../types.js";

export const LOG_SEARCH_LIMIT = 200;

export function buildLogQuery(query: string): string {
  const trimmed = query.trim();
  if (/\bstatus\s*:/i.test(trimmed)) return trimmed;
  return `${trimmed} status:error`;
}

export function buildLogSearchBody(
  query: string,
  from: string,
  to: string,
): {
  filter: { query: string; from: string; to: string };
  page: { limit: number };
} {
  return {
    filter: {
      query: buildLogQuery(query),
      from,
      to,
    },
    page: { limit: LOG_SEARCH_LIMIT },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function splitStack(text: string): { message: string; stack?: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match =
    /\n(?:\s+at\s+|Traceback \(most recent call|\s+File ["']|\s+\S+\.go:\d+)/.exec(
      normalized,
    );
  if (!match || match.index === undefined) {
    return { message: normalized.trim() };
  }
  const message = normalized.slice(0, match.index).trim();
  const stack = normalized.slice(match.index).trim();
  return { message: message || normalized.trim(), stack };
}

function cappedAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attributes) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (out && Object.keys(out).length >= 20) break;
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      out[key] = value;
  }
  return out;
}

export function signalsFromDatadogResponse(
  payload: unknown,
  fallbackService: string,
): Signal[] {
  const root = asRecord(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  const signals: Signal[] = [];
  for (const item of data) {
    const wrapper = asRecord(item);
    const attributes = asRecord(wrapper?.attributes) ?? wrapper ?? {};
    const nested = asRecord(attributes.attributes);
    const rawMessage =
      asString(attributes.message) ||
      asString(nested?.message) ||
      asString(attributes.msg) ||
      asString(nested?.error) ||
      "";
    if (!rawMessage) continue;
    const { message, stack } = splitStack(rawMessage);
    const nestedStack =
      asString(nested?.stack) || asString(asRecord(nested?.error)?.stack);
    signals.push({
      source: "datadog",
      timestamp: asString(attributes.timestamp) || new Date(0).toISOString(),
      service: asString(attributes.service) || fallbackService,
      severity:
        asString(attributes.status) || asString(nested?.status) || "error",
      message,
      stack: stack || nestedStack,
      attributes: cappedAttributes(nested ?? attributes),
    });
  }
  return signals;
}

export async function searchDatadogLogs(
  credentials: DatadogCredentials,
  input: { query: string; from: string; to: string; service: string },
): Promise<Signal[]> {
  const url = `${datadogApiBase(credentials.site)}/api/v2/logs/events/search`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "DD-API-KEY": credentials.apiKey,
        "DD-APPLICATION-KEY": credentials.appKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(
        buildLogSearchBody(input.query, input.from, input.to),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not search Datadog logs: ${message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new DatadogUnauthorizedError();
  }
  if (!response.ok) {
    throw new CliError(
      `Datadog log search failed with HTTP ${response.status}.`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliError(
      "Datadog log search returned a response that was not JSON.",
    );
  }
  return signalsFromDatadogResponse(payload, input.service);
}
