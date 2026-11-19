#!/usr/bin/env node
import { Command } from "commander";
import { configureDatadog } from "./auth/datadog.js";
import { configureGithub, githubAuthState } from "./auth/github.js";
import { configureLlm } from "./auth/llm.js";
import { confirm, isInteractive } from "./auth/prompt.js";
import { loadCredentials } from "./auth/store.js";
import { dispatchDeploy, planDeploy } from "./deploy/gate.js";
import { CliError } from "./errors.js";
import { investigate } from "./investigate.js";
import { listRuns } from "./runs/store.js";

const program = new Command();

program
  .name("akg-debug")
  .description("Investigate a service failure from Datadog and Kubernetes, open a pull request, and deploy through an existing GitHub Actions workflow.")
  .version("0.1.0");

const auth = program.command("auth").description("Store credentials on this machine or show what is configured");

auth
  .command("datadog")
  .description("Prompt for Datadog keys and validate them")
  .action(async () => {
    await configureDatadog();
  });

auth
  .command("github")
  .description("Require gh auth status, and start gh auth login once if needed")
  .action(async () => {
    await configureGithub();
  });

auth
  .command("llm")
  .description("Prompt once for an OpenAI-compatible API key and base URL")
  .action(async () => {
    await configureLlm();
  });

auth
  .command("status")
  .description("Show configured or missing credentials, and the kube context name if known")
  .action(async () => {
    const credentials = loadCredentials();
    const datadog = credentials.datadog?.apiKey && credentials.datadog?.appKey ? "configured" : "missing";
    const llm = credentials.llm?.apiKey ? "configured" : "missing";
    const github = await githubAuthState();
    const kube = credentials.kube?.context?.trim() || "missing";
    console.log(`datadog: ${datadog}`);
    console.log(`github: ${github}`);
    console.log(`llm: ${llm}`);
    console.log(`kube context: ${kube}`);
  });

program
  .command("investigate")
  .description("Read logs, diagnose against the repo, and optionally open a pull request")
  .option("--repo <path>", "service repository (default: current directory)")
  .option("--since <window>", "lookback window such as 30m, 1h, or 2d", "1h")
  .option("--service <name>", "service name (overrides .akg-debug.yml)")
  .option("--namespace <namespace>", "Kubernetes namespace (overrides .akg-debug.yml)")
  .option("--query <query>", "Datadog log query (overrides .akg-debug.yml)")
  .option("--yes", "open a pull request without prompting")
  .action(async (options: {
    repo?: string;
    since?: string;
    service?: string;
    namespace?: string;
    query?: string;
    yes?: boolean;
  }) => {
    await investigate(options, confirm);
  });

program
  .command("deploy")
  .description("Dispatch the repo deploy workflow for a saved run after an explicit confirmation")
  .argument("<run-id>", "id printed by investigate or listed by akg-debug runs")
  .option("--approve", "confirm the deploy without an interactive prompt")
  .option("--ignore-checks", "dispatch even if pull request checks are pending or failing")
  .action(async (runId: string, options: { approve?: boolean; ignoreChecks?: boolean }) => {
    const plan = await planDeploy(runId);
    if (!plan.checksPassing && !options.ignoreChecks) {
      throw new CliError(
        `Pull request checks are not passing (${plan.checksDetail}). Nothing was dispatched. Re-run with --ignore-checks to override, or wait for checks.`,
      );
    }
    if (!options.approve) {
      if (!isInteractive()) {
        throw new CliError(
          `Deploy does nothing without confirmation. Run \`akg-debug deploy ${plan.run.id} --approve\` to dispatch the workflow for ${plan.run.service}.`,
        );
      }
      const proceed = await confirm(
        `Deploy service ${plan.run.service} by dispatching ${plan.workflow}? This does not merge the pull request.`,
      );
      if (!proceed) {
        console.log("Deploy cancelled. Nothing was dispatched.");
        return;
      }
      if (!plan.checksPassing && options.ignoreChecks) {
        const override = await confirm(
          `Checks are not passing for ${plan.run.service}. Deploy service ${plan.run.service} anyway?`,
        );
        if (!override) {
          console.log("Deploy cancelled. Nothing was dispatched.");
          return;
        }
      }
    }
    const ref = await dispatchDeploy(plan, { ignoreChecks: Boolean(options.ignoreChecks) });
    console.log(`Dispatched ${plan.workflow} on ref ${ref} for ${plan.run.service}. The pull request was not merged.`);
  });

program
  .command("runs")
  .description("List diagnoses saved on this machine")
  .action(() => {
    const runs = listRuns();
    if (runs.length === 0) {
      console.log("No saved runs.");
      return;
    }
    for (const run of runs) {
      console.log([run.id, run.createdAt, run.service, run.status, run.prUrl ?? ""].filter(Boolean).join("  "));
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
