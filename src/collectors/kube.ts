import { CliError, KubeAuthError } from "../errors.js";
import { kubeAuthError } from "../auth/kube.js";
import { firstLine, runCommand } from "../process.js";
import type { Signal } from "../types.js";

const MAX_PODS = 20;
const LOG_TAIL = 200;
const MAX_LOG_LINES = 200;
const MAX_EVENTS = 50;

interface PodRef {
  name: string;
  containers: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function parsePodList(payload: unknown): PodRef[] {
  const root = asRecord(payload);
  const items = Array.isArray(root?.items) ? root.items : [];
  const pods: PodRef[] = [];
  for (const item of items) {
    const pod = asRecord(item);
    const meta = asRecord(pod?.metadata);
    const spec = asRecord(pod?.spec);
    const name = typeof meta?.name === "string" ? meta.name : "";
    if (!name) continue;
    const containers = Array.isArray(spec?.containers)
      ? spec.containers
          .map((container) => asRecord(container)?.name)
          .filter(
            (containerName): containerName is string =>
              typeof containerName === "string",
          )
      : [];
    pods.push({ name, containers });
  }
  return pods;
}

function capLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return lines.join("\n").trim();
  return lines
    .slice(lines.length - maxLines)
    .join("\n")
    .trim();
}

function throwIfAuth(text: string, contextName?: string): void {
  const auth = kubeAuthError(text, contextName);
  if (auth) throw auth;
}

async function kubectl(
  args: string[],
  contextName?: string,
): Promise<{ stdout: string; stderr: string }> {
  let result;
  try {
    result = await runCommand("kubectl", args);
  } catch (error) {
    if (error instanceof CliError && /not installed/.test(error.message))
      throw error;
    throw error;
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  throwIfAuth(combined, contextName);
  if (result.exitCode !== 0) {
    throw new CliError(
      `kubectl ${args[0]} failed: ${firstLine(result.stderr || result.stdout) || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}

export async function collectKubeLogs(input: {
  namespace: string;
  selector: string;
  since: string;
  service: string;
  contextName?: string;
}): Promise<Signal[]> {
  const { namespace, selector, since, service, contextName } = input;
  const podsResult = await kubectl(
    ["get", "pods", "-n", namespace, "-l", selector, "-o", "json"],
    contextName,
  );
  let podPayload: unknown;
  try {
    podPayload = JSON.parse(podsResult.stdout);
  } catch {
    throw new CliError("kubectl get pods returned invalid JSON.");
  }
  const pods = parsePodList(podPayload).slice(0, MAX_PODS);
  const signals: Signal[] = [];
  const now = new Date().toISOString();

  for (const pod of pods) {
    const args = [
      "logs",
      pod.name,
      "-n",
      namespace,
      `--since=${since}`,
      `--tail=${LOG_TAIL}`,
    ];
    if (pod.containers.length > 1) args.push("--all-containers");
    let logs;
    try {
      logs = await runCommand("kubectl", args);
    } catch (error) {
      if (error instanceof KubeAuthError || error instanceof CliError)
        throw error;
      continue;
    }
    const combined = `${logs.stderr}\n${logs.stdout}`;
    throwIfAuth(combined, contextName);
    if (logs.exitCode !== 0) {
      signals.push({
        source: "k8s",
        timestamp: now,
        service,
        severity: "error",
        message: `kubectl logs ${pod.name} failed: ${firstLine(logs.stderr || logs.stdout) || `exit ${logs.exitCode}`}`,
        attributes: { pod: pod.name, namespace, selector },
      });
      continue;
    }
    const text = capLines(logs.stdout, MAX_LOG_LINES);
    if (!text) continue;
    const firstLineOfLog =
      text
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? text;
    signals.push({
      source: "k8s",
      timestamp: now,
      service,
      severity: "error",
      message: firstLineOfLog.slice(0, 2000),
      stack: text,
      attributes: {
        pod: pod.name,
        namespace,
        selector,
        containers: pod.containers,
      },
    });
  }

  const events = await kubectl(
    ["get", "events", "-n", namespace, "-o", "json"],
    contextName,
  );
  let eventPayload: unknown;
  try {
    eventPayload = JSON.parse(events.stdout);
  } catch {
    throw new CliError("kubectl get events returned invalid JSON.");
  }
  signals.push(...signalsFromEvents(eventPayload, service, namespace));
  return signals;
}

export function signalsFromEvents(
  payload: unknown,
  service: string,
  namespace: string,
): Signal[] {
  const root = asRecord(payload);
  const items = Array.isArray(root?.items) ? root.items : [];
  const ranked = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .sort((a, b) => {
      const aWarn = asRecord(a)?.type === "Warning" ? 0 : 1;
      const bWarn = asRecord(b)?.type === "Warning" ? 0 : 1;
      return aWarn - bWarn;
    })
    .slice(0, MAX_EVENTS);

  const signals: Signal[] = [];
  for (const event of ranked) {
    const message =
      typeof event.message === "string" ? event.message.trim() : "";
    if (!message) continue;
    const involved = asRecord(event.involvedObject);
    const metadata = asRecord(event.metadata);
    const timestamp =
      (typeof event.lastTimestamp === "string" && event.lastTimestamp) ||
      (typeof event.eventTime === "string" && event.eventTime) ||
      (typeof metadata?.creationTimestamp === "string" &&
        metadata.creationTimestamp) ||
      new Date(0).toISOString();
    const kind = typeof event.type === "string" ? event.type : "Normal";
    signals.push({
      source: "k8s",
      timestamp,
      service,
      severity: kind === "Warning" ? "warning" : "info",
      message,
      attributes: {
        namespace,
        reason: event.reason ?? "",
        type: kind,
        involved: involved?.name ?? "",
        involvedKind: involved?.kind ?? "",
      },
    });
  }
  return signals;
}
