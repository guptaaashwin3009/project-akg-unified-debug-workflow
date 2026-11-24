import fs from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import { loadTeamConfig } from "../config.js";
import { firstLine, runCommand } from "../process.js";
import { loadRun, saveRun } from "../runs/store.js";
import type { RunRecord } from "../types.js";

export interface DeployPlan {
  run: RunRecord;
  workflow: string;
  deployRef?: string;
  workflowInputs: Record<string, string>;
  checksPassing: boolean;
  checksDetail: string;
}

async function prChecksPassing(
  repo: string,
  prUrl: string,
): Promise<{ passing: boolean; detail: string }> {
  const result = await runCommand("gh", ["pr", "checks", prUrl], { cwd: repo });
  if (result.exitCode === 0) return { passing: true, detail: "passing" };
  return {
    passing: false,
    detail:
      firstLine(result.stdout || result.stderr) ||
      `gh pr checks exited ${result.exitCode}`,
  };
}

async function pullRequestHead(
  repo: string,
  prUrl: string,
  recordedBranch?: string,
): Promise<string> {
  if (recordedBranch) return recordedBranch;
  const result = await runCommand(
    "gh",
    ["pr", "view", prUrl, "--json", "headRefName", "--jq", ".headRefName"],
    {
      cwd: repo,
    },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new CliError(
      firstLine(result.stderr || result.stdout) ||
        "Could not read the pull request head branch.",
    );
  }
  return result.stdout.trim();
}

/** Read-only checks. Does not dispatch, merge, or change the cluster. */
export async function planDeploy(runId: string): Promise<DeployPlan> {
  const run = loadRun(runId);
  if (!run.prUrl) {
    throw new CliError(
      `Run ${run.id} has no pull request. Open one with akg-debug investigate before deploying.`,
    );
  }
  const team = loadTeamConfig(run.repo);
  const workflow = team.github?.deployWorkflow;
  if (!workflow) {
    throw new CliError(
      `Run ${run.id} has no github.deployWorkflow in ${path.join(run.repo, ".akg-debug.yml")}.`,
    );
  }
  const workflowFile = path.join(run.repo, ".github", "workflows", workflow);
  if (!fs.existsSync(workflowFile)) {
    throw new CliError(
      `Workflow file .github/workflows/${workflow} does not exist in ${run.repo}. Nothing was dispatched and the pull request was not merged.`,
    );
  }
  const checks = await prChecksPassing(run.repo, run.prUrl);
  return {
    run,
    workflow,
    deployRef: team.github?.deployRef,
    workflowInputs: team.github?.workflowInputs ?? {},
    checksPassing: checks.passing,
    checksDetail: checks.detail,
  };
}

export async function dispatchDeploy(
  plan: DeployPlan,
  options: { ignoreChecks: boolean },
): Promise<string> {
  if (!plan.checksPassing && !options.ignoreChecks) {
    throw new CliError(
      `Pull request checks are not passing (${plan.checksDetail}). Nothing was dispatched. Re-run with --ignore-checks to override, or wait for checks.`,
    );
  }
  const ref =
    plan.deployRef ||
    (await pullRequestHead(
      plan.run.repo,
      plan.run.prUrl as string,
      plan.run.branch,
    ));
  const args = ["workflow", "run", plan.workflow, "--ref", ref];
  for (const [key, value] of Object.entries(plan.workflowInputs)) {
    if (key.includes("=") || /[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new CliError(
        `Workflow input "${key}" cannot be passed safely. Nothing was dispatched.`,
      );
    }
    args.push("-f", `${key}=${value}`);
  }
  const dispatched = await runCommand("gh", args, { cwd: plan.run.repo });
  if (dispatched.exitCode !== 0) {
    throw new CliError(
      firstLine(dispatched.stderr || dispatched.stdout) ||
        "gh workflow run failed. The pull request was not merged and the cluster was not changed directly.",
    );
  }
  saveRun({ ...plan.run, status: "deploy-dispatched" });
  return ref;
}
