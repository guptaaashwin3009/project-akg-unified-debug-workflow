import path from "node:path";
import { ensureDatadog, replaceDatadogAfterRejection } from "./auth/datadog.js";
import { ensureGithub } from "./auth/github.js";
import { rememberKubeContext } from "./auth/kube.js";
import { ensureLlm, replaceLlmAfterRejection } from "./auth/llm.js";
import { isInteractive } from "./auth/prompt.js";
import { searchDatadogLogs } from "./collectors/datadog.js";
import { collectKubeLogs } from "./collectors/kube.js";
import { loadTeamConfig, parseSince, resolveInvestigateConfig } from "./config.js";
import { LlmUnauthorizedError, requestDiagnosis } from "./diagnose/llm.js";
import { CliError, DatadogUnauthorizedError, KubeAuthError } from "./errors.js";
import { checkDiffApplies, openPullRequest } from "./git/pr.js";
import { createRunId } from "./ids.js";
import { correlateSignals } from "./normalize/correlate.js";
import { groupSignals } from "./normalize/fingerprint.js";
import { firstLine, runCommand } from "./process.js";
import { saveRun } from "./runs/store.js";
import type { Diagnosis, RunRecord, Signal } from "./types.js";

export interface InvestigateFlags {
  repo?: string;
  since?: string;
  service?: string;
  namespace?: string;
  query?: string;
  yes?: boolean;
}

function formatDiagnosis(diagnosis: Diagnosis): string {
  return [
    diagnosis.summary,
    "",
    `Confidence: ${diagnosis.confidence}`,
    "",
    "Root cause",
    diagnosis.rootCause,
    "",
    "Evidence",
    ...(diagnosis.evidence.length ? diagnosis.evidence.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "Test plan",
    ...(diagnosis.testPlan.length ? diagnosis.testPlan.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "Deploy notes",
    diagnosis.deployNotes || "None.",
    "",
    "Diff",
    diagnosis.diff.trim() ? diagnosis.diff.trimEnd() : "(no diff)",
  ].join("\n");
}

async function resolveRepo(repoFlag?: string): Promise<string> {
  const start = path.resolve(repoFlag || process.cwd());
  const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: start });
  if (top.exitCode !== 0) {
    throw new CliError(
      firstLine(top.stderr) || `${start} is not a git repository. Pass --repo pointing at the service checkout.`,
    );
  }
  return top.stdout.trim();
}

async function collectDatadog(input: {
  query: string;
  from: string;
  to: string;
  service: string;
}): Promise<Signal[]> {
  let credentials = await ensureDatadog();
  try {
    return await searchDatadogLogs(credentials, input);
  } catch (error) {
    if (!(error instanceof DatadogUnauthorizedError)) throw error;
    credentials = await replaceDatadogAfterRejection();
    return searchDatadogLogs(credentials, input);
  }
}

async function diagnoseWithAuth(
  request: Parameters<typeof requestDiagnosis>[1],
): Promise<Diagnosis> {
  let credentials = await ensureLlm();
  try {
    return await requestDiagnosis(credentials, request);
  } catch (error) {
    if (!(error instanceof LlmUnauthorizedError)) throw error;
    credentials = await replaceLlmAfterRejection();
    return requestDiagnosis(credentials, request);
  }
}

export async function investigate(flags: InvestigateFlags, confirm: (question: string) => Promise<boolean>): Promise<void> {
  const repo = await resolveRepo(flags.repo);
  const team = loadTeamConfig(repo);
  const resolved = resolveInvestigateConfig(repo, flags, team);
  const window = parseSince(resolved.since);
  const runId = createRunId();
  const branch = `akg-debug/${runId}`;

  console.log(`Run ${runId}`);
  console.log(`Repo ${repo}`);
  console.log(`Service ${resolved.service} in namespace ${resolved.namespace} since ${resolved.since}`);

  console.log("Searching Datadog logs.");
  const datadogSignals = await collectDatadog({
    query: resolved.query,
    from: window.from,
    to: window.to,
    service: resolved.service,
  });

  console.log("Reading Kubernetes pods, logs, and events.");
  let contextName: string | undefined;
  try {
    contextName = await rememberKubeContext();
  } catch (error) {
    if (error instanceof KubeAuthError) throw new CliError(error.message);
    throw error;
  }
  let kubeSignals: Signal[];
  try {
    kubeSignals = await collectKubeLogs({
      namespace: resolved.namespace,
      selector: resolved.selector,
      since: resolved.since,
      service: resolved.service,
      contextName,
    });
  } catch (error) {
    if (error instanceof KubeAuthError) throw new CliError(error.message);
    throw error;
  }

  const signals = [...datadogSignals, ...kubeSignals];
  if (signals.length === 0) {
    console.log("No Datadog or Kubernetes signals were found in that window. No pull request was opened.");
    return;
  }

  const groups = groupSignals(signals, 5);
  console.log(`Fingerprinted ${signals.length} signal${signals.length === 1 ? "" : "s"} into ${groups.length} group${groups.length === 1 ? "" : "s"}.`);
  console.log("Correlating stack frames and error text with the repo.");
  const excerpts = correlateSignals(repo, signals, groups);

  const baseRequest = {
    service: resolved.service,
    from: window.from,
    to: window.to,
    groups,
    excerpts,
    allow: resolved.allow,
  };

  console.log("Requesting one diagnosis.");
  let diagnosis = await diagnoseWithAuth(baseRequest);
  console.log("");
  console.log(formatDiagnosis(diagnosis));
  console.log("");

  let rejection = diagnosis.diff.trim() ? await checkDiffApplies(repo, diagnosis.diff, resolved.allow) : null;
  if (rejection) {
    console.error(`Diff was rejected: ${rejection}`);
    console.error("Asking the model once more with the apply error.");
    diagnosis = await diagnoseWithAuth({
      ...baseRequest,
      rejection: { reason: rejection, diff: diagnosis.diff },
    });
    console.log("");
    console.log(formatDiagnosis(diagnosis));
    console.log("");
    rejection = diagnosis.diff.trim()
      ? await checkDiffApplies(repo, diagnosis.diff, resolved.allow)
      : "model returned an empty diff";
    if (rejection) {
      saveRun(record({
        id: runId,
        repo,
        service: resolved.service,
        namespace: resolved.namespace,
        diagnosis,
        status: "apply-failed",
      }));
      throw new CliError(
        `Diff could not be applied cleanly: ${rejection}. Saved run ${runId}. The git tree was not changed.`,
      );
    }
  }

  const savedDiagnosis = record({
    id: runId,
    repo,
    service: resolved.service,
    namespace: resolved.namespace,
    diagnosis,
    status: "diagnosed",
  });

  if (!diagnosis.diff.trim()) {
    saveRun(savedDiagnosis);
    console.log(`No code change was proposed. Saved run ${runId} without a pull request.`);
    return;
  }

  if (!flags.yes && !isInteractive()) {
    saveRun(savedDiagnosis);
    throw new CliError(
      `Saved run ${runId} without a pull request because stdin is not a terminal. Re-run with --yes to open a pull request without a prompt.`,
    );
  }

  const accepted = flags.yes || (await confirm("Open a pull request with this fix?"));
  if (!accepted) {
    saveRun(savedDiagnosis);
    console.log(`Saved run ${runId} without a pull request.`);
    return;
  }

  saveRun(savedDiagnosis);
  await ensureGithub();
  const prUrl = await openPullRequest({
    repo,
    branch,
    diagnosis,
    service: resolved.service,
    allow: resolved.allow,
  });
  saveRun({ ...savedDiagnosis, branch, status: "pr-opened", prUrl });
  console.log(`Opened ${prUrl}`);
  console.log(`Saved run ${runId}. Deploy later with \`akg-debug deploy ${runId}\`.`);
}

function record(input: {
  id: string;
  repo: string;
  service: string;
  namespace?: string;
  branch?: string;
  diagnosis: Diagnosis;
  status: RunRecord["status"];
  prUrl?: string;
}): RunRecord {
  return {
    id: input.id,
    createdAt: new Date().toISOString(),
    repo: input.repo,
    service: input.service,
    namespace: input.namespace,
    branch: input.branch,
    summary: input.diagnosis.summary,
    diff: input.diagnosis.diff,
    prUrl: input.prUrl,
    status: input.status,
    diagnosis: input.diagnosis,
  };
}
