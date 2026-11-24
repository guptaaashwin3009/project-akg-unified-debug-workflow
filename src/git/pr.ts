import { CliError } from "../errors.js";
import { extractDiffPaths, unsafeDiffReason } from "./safety.js";
import { firstLine, runCommand } from "../process.js";
import type { Diagnosis } from "../types.js";

export async function checkDiffApplies(
  repo: string,
  diff: string,
  allow?: string[],
): Promise<string | null> {
  const safety = unsafeDiffReason(diff, { repoRoot: repo, allow });
  if (safety) return safety;
  const result = await runCommand(
    "git",
    ["apply", "--check", "--whitespace=nowarn"],
    {
      cwd: repo,
      input: diff.endsWith("\n") ? diff : `${diff}\n`,
    },
  );
  if (result.exitCode === 0) return null;
  return (
    firstLine(result.stderr || result.stdout) ||
    `git apply --check exited ${result.exitCode}`
  );
}

export async function openPullRequest(input: {
  repo: string;
  branch: string;
  diagnosis: Diagnosis;
  service: string;
  allow?: string[];
}): Promise<string> {
  const { repo, branch, diagnosis, service, allow } = input;
  const blocked = unsafeDiffReason(diagnosis.diff, { repoRoot: repo, allow });
  if (blocked) throw new CliError(`Refusing to apply the diff: ${blocked}`);
  const paths = extractDiffPaths(diagnosis.diff);
  if (paths.length === 0)
    throw new CliError(
      "Refusing to apply a diff that does not name any files.",
    );
  const dirty = await runCommand(
    "git",
    ["status", "--porcelain", "--", ...paths],
    { cwd: repo },
  );
  if (dirty.exitCode !== 0) {
    throw new CliError(
      firstLine(dirty.stderr) ||
        "Could not read git status before applying the diff.",
    );
  }
  if (dirty.stdout.trim()) {
    throw new CliError(
      `Refusing to change files that already have local edits: ${dirty.stdout
        .trim()
        .split(/\r?\n/)
        .slice(0, 10)
        .join(", ")}`,
    );
  }
  const current = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repo },
  );
  if (current.exitCode !== 0) {
    throw new CliError(
      firstLine(current.stderr) || "Could not read the current git branch.",
    );
  }
  const previous = current.stdout.trim();
  const created = await runCommand("git", ["checkout", "-b", branch], {
    cwd: repo,
  });
  if (created.exitCode !== 0) {
    throw new CliError(
      firstLine(created.stderr) || `Could not create branch ${branch}.`,
    );
  }

  const applied = await runCommand("git", ["apply", "--whitespace=nowarn"], {
    cwd: repo,
    input: diagnosis.diff.endsWith("\n")
      ? diagnosis.diff
      : `${diagnosis.diff}\n`,
  });
  if (applied.exitCode !== 0) {
    await runCommand("git", ["apply", "-R", "--whitespace=nowarn"], {
      cwd: repo,
      input: diagnosis.diff.endsWith("\n")
        ? diagnosis.diff
        : `${diagnosis.diff}\n`,
    });
    await runCommand("git", ["checkout", previous], { cwd: repo });
    await runCommand("git", ["branch", "-d", branch], { cwd: repo });
    throw new CliError(
      `git apply failed after the check succeeded: ${firstLine(applied.stderr || applied.stdout) || applied.exitCode}. The working tree was left on ${previous}.`,
    );
  }

  const added = await runCommand("git", ["add", "--", ...paths], { cwd: repo });
  if (added.exitCode !== 0) {
    throw new CliError(
      firstLine(added.stderr) ||
        "git add failed. The new branch was left in place and was not pushed.",
    );
  }

  const message = diagnosis.summary.trim() || `akg-debug fix for ${service}`;
  const committed = await runCommand("git", ["commit", "-m", message], {
    cwd: repo,
  });
  if (committed.exitCode !== 0) {
    throw new CliError(
      firstLine(committed.stderr || committed.stdout) ||
        "git commit failed. Hooks were not skipped. The branch was not pushed.",
    );
  }

  const pushed = await runCommand("git", ["push", "-u", "origin", branch], {
    cwd: repo,
  });
  if (pushed.exitCode !== 0) {
    throw new CliError(
      firstLine(pushed.stderr || pushed.stdout) ||
        `git push failed. Branch ${branch} exists locally and was not force-pushed.`,
    );
  }

  const title = `fix(${service}): ${diagnosis.summary}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const body = [
    diagnosis.summary,
    "",
    "## Root cause",
    diagnosis.rootCause,
    "",
    "## Evidence",
    ...diagnosis.evidence.map((item) => `- ${item}`),
    "",
    "## Test plan",
    ...diagnosis.testPlan.map((item) => `- [ ] ${item}`),
    "",
    "## Deploy notes",
    diagnosis.deployNotes || "None.",
    "",
    "Opened by akg-debug. This pull request is not merged automatically.",
  ].join("\n");

  const pr = await runCommand(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--head", branch],
    { cwd: repo },
  );
  if (pr.exitCode !== 0) {
    throw new CliError(
      firstLine(pr.stderr || pr.stdout) ||
        `gh pr create failed. Branch ${branch} was pushed and no pull request was merged.`,
    );
  }
  const url = pr.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("http"));
  if (!url) {
    throw new CliError(
      `gh pr create succeeded but did not print a URL. Branch ${branch} was pushed.`,
    );
  }
  return url;
}
