import { CliError, KubeAuthError } from "../errors.js";
import { runCommand } from "../process.js";
import { updateCredentials } from "./store.js";

export function looksLikeKubeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("you must be logged in") ||
    lower.includes("must be logged in to the server") ||
    lower.includes("the server has asked for the client to provide credentials") ||
    lower.includes("invalid usertoken") ||
    lower.includes("authentication required")
  );
}

export async function rememberKubeContext(): Promise<string> {
  let result;
  try {
    result = await runCommand("kubectl", ["config", "current-context"]);
  } catch (error) {
    if (error instanceof CliError && /kubectl/i.test(error.message) && /not found|ENOENT/i.test(error.message)) {
      throw new CliError("kubectl is not installed or not on PATH.");
    }
    throw error;
  }
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const detail = result.stderr.trim().split(/\r?\n/).find(Boolean);
    throw new CliError(
      detail
        ? `Could not read the current kubectl context: ${detail}`
        : "Could not read the current kubectl context. Select one with kubectl and retry.",
    );
  }
  const context = result.stdout.trim();
  updateCredentials({ kube: { context } });
  return context;
}

export function kubeAuthError(text: string, contextName?: string): KubeAuthError | undefined {
  if (!looksLikeKubeAuthFailure(text)) return undefined;
  return new KubeAuthError(contextName);
}
