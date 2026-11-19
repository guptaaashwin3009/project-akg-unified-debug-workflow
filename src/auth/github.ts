import { CliError } from "../errors.js";
import { runCommand } from "../process.js";
import { isInteractive } from "./prompt.js";

export async function githubAuthState(): Promise<"configured" | "missing"> {
  try {
    const result = await runCommand("gh", ["auth", "status"]);
    return result.exitCode === 0 ? "configured" : "missing";
  } catch {
    return "missing";
  }
}

export async function configureGithub(): Promise<void> {
  const state = await githubAuthState();
  if (state === "configured") {
    console.log("GitHub CLI is already authenticated.");
    return;
  }
  if (!isInteractive()) {
    throw new CliError("GitHub CLI is not authenticated. Run `akg-debug auth github` in a terminal.");
  }
  const login = await runCommand("gh", ["auth", "login"], { stdio: "inherit" });
  if (login.exitCode !== 0) {
    throw new CliError("GitHub authentication did not complete. Run `akg-debug auth github` to try again.");
  }
  const after = await githubAuthState();
  if (after !== "configured") {
    throw new CliError("GitHub CLI is still not authenticated. Run `gh auth login`, then `akg-debug auth github`.");
  }
  console.log("GitHub CLI is authenticated.");
}

export async function ensureGithub(): Promise<void> {
  const state = await githubAuthState();
  if (state === "configured") return;
  if (!isInteractive()) {
    throw new CliError("GitHub CLI is not authenticated. Run `akg-debug auth github` and try again.");
  }
  console.error("GitHub CLI is not authenticated. Starting `gh auth login`.");
  await configureGithub();
}
