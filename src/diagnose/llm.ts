import type { CodeExcerpt, Confidence, Diagnosis, Signal } from "../types.js";
import type { SignalGroup } from "../normalize/fingerprint.js";
import type { LlmCredentials } from "../auth/store.js";
import { CliError } from "../errors.js";

export class LlmUnauthorizedError extends Error {
  constructor() {
    super("The model API rejected the API key.");
    this.name = "LlmUnauthorizedError";
  }
}

const SYSTEM_PROMPT = `You are akg-debug. Diagnose one production failure from log fingerprints, a few raw samples, and source excerpts.
Return a single JSON object and nothing else. The keys must be:
- summary: string, one or two sentences explaining the failure
- evidence: array of strings
- confidence: one of "low", "medium", "high"
- rootCause: string
- diff: string, a unified diff that git apply can apply. Use repo-relative paths in "diff --git a/<path> b/<path>" form. Use an empty string when you cannot propose a safe code change.
- testPlan: array of strings
- deployNotes: string
The diff must stay inside the repository. Do not touch .git, absolute paths, or any path containing "..". When an allowlist is provided, only change files that match it. Do not include secrets.`;

export function parseJsonContent(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new CliError("Model response was not valid JSON.");
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function confidenceOf(value: unknown): Confidence | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

export function parseDiagnosis(text: string): Diagnosis {
  let parsed: unknown;
  try {
    parsed = parseJsonContent(text);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Model response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Model response was not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const summary = asString(record.summary)?.trim();
  const rootCause = (asString(record.rootCause) ?? asString(record.root_cause))?.trim();
  const confidence = confidenceOf(record.confidence);
  const evidence = asStringList(record.evidence);
  const testPlan = asStringList(record.testPlan) ?? asStringList(record.test_plan);
  const diff = asString(record.diff) ?? "";
  const deployNotes = (asString(record.deployNotes) ?? asString(record.deploy_notes) ?? "").trim();
  if (!summary || !rootCause || !confidence || !evidence || !testPlan) {
    throw new CliError(
      "Model JSON is missing summary, evidence, confidence, rootCause, or testPlan.",
    );
  }
  return {
    summary,
    evidence,
    confidence,
    rootCause,
    diff,
    testPlan,
    deployNotes,
  };
}

export interface DiagnosisRequest {
  service: string;
  from: string;
  to: string;
  groups: SignalGroup[];
  excerpts: CodeExcerpt[];
  allow?: string[];
  rejection?: {
    reason: string;
    diff: string;
  };
}

function sampleView(signal: Signal): Record<string, unknown> {
  return {
    source: signal.source,
    timestamp: signal.timestamp,
    service: signal.service,
    severity: signal.severity,
    message: signal.message.slice(0, 2000),
    stack: signal.stack?.slice(0, 4000),
    attributes: signal.attributes,
  };
}

export function buildDiagnosisMessages(request: DiagnosisRequest): Array<{ role: "system" | "user"; content: string }> {
  const payload = {
    service: request.service,
    window: { from: request.from, to: request.to },
    patchAllow: request.allow ?? "all repository files except .git, absolute paths, and path traversal",
    fingerprints: request.groups.map((group) => ({
      template: group.template,
      count: group.count,
      samples: group.samples.map(sampleView),
    })),
    excerpts: request.excerpts.map((excerpt) => ({
      file: excerpt.file,
      line: excerpt.line,
      reason: excerpt.reason,
      excerpt: excerpt.excerpt.slice(0, 4000),
    })),
    previousRejection: request.rejection
      ? {
          reason: request.rejection.reason.slice(0, 4000),
          diff: request.rejection.diff.slice(0, 12000),
        }
      : undefined,
  };
  let content = JSON.stringify(payload, null, 2);
  if (content.length > 80_000) content = content.slice(0, 80_000);
  const instruction = request.rejection
    ? "The previous diff was rejected. Return a new JSON diagnosis whose diff fixes that rejection."
    : "Return the JSON diagnosis.";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${instruction}\n${content}` },
  ];
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function postChat(credentials: LlmCredentials, messages: Array<{ role: string; content: string }>, jsonMode: boolean): Promise<Response> {
  const body: Record<string, unknown> = {
    model: process.env.AKG_DEBUG_MODEL || "gpt-4o-mini",
    temperature: 0,
    messages,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  return fetch(chatUrl(credentials.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

export async function requestDiagnosis(credentials: LlmCredentials, request: DiagnosisRequest): Promise<Diagnosis> {
  const messages = buildDiagnosisMessages(request);
  let response: Response;
  try {
    response = await postChat(credentials, messages, true);
    if (response.status === 400) {
      response = await postChat(credentials, messages, false);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`The model request failed: ${message}`);
  }
  if (response.status === 401 || response.status === 403) throw new LlmUnauthorizedError();
  if (!response.ok) {
    throw new CliError(`The model request failed with HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("The model response was not JSON.");
  }
  const record = payload as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new CliError("The model response did not include a message.");
  }
  return parseDiagnosis(content);
}
