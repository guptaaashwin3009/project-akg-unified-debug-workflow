import { execa, type Options } from "execa";
import { CliError } from "./errors.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; stdio?: Options["stdio"] } = {},
): Promise<CommandResult> {
  try {
    const result = await execa(command, args, {
      cwd: options.cwd,
      input: options.input,
      stdio: options.stdio,
      reject: false,
      windowsHide: true,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new CliError(`${command} is not installed or not on PATH.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${command} failed: ${message}`);
  }
}

export function firstLine(text: string, max = 300): string {
  const line = text.trim().split(/\r?\n/).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
