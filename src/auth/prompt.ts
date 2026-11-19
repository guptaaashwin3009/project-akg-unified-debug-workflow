import readline from "node:readline";
import { CliError } from "../errors.js";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function requireInteractive(command: string): void {
  if (!isInteractive()) {
    throw new CliError(
      `This step needs input, and stdin is not a terminal. Run \`${command}\` in a terminal, then retry.`,
    );
  }
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  if (!isInteractive()) {
    throw new CliError("Cannot prompt because stdin is not a terminal.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}${suffix}: `, resolve);
    });
    const trimmed = answer.trim();
    if (trimmed) return trimmed;
    return defaultValue ?? "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N]`);
  return /^y(es)?$/i.test(answer.trim());
}

export async function promptSecret(label: string): Promise<string> {
  if (!isInteractive()) {
    throw new CliError("Cannot prompt for a secret because stdin is not a terminal.");
  }
  process.stdout.write(`${label}: `);
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  stdin.resume();
  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);

  const value = await new Promise<string>((resolve, reject) => {
    let collected = "";
    const finish = (result: string | Error) => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          finish(collected.trim());
          return;
        }
        if (ch === "\u0003") {
          finish(new CliError("Aborted."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          collected = collected.slice(0, -1);
          continue;
        }
        if (ch === "\u0015") {
          collected = "";
          continue;
        }
        collected += ch;
      }
    };
    stdin.on("data", onData);
  });

  if (!value) throw new CliError(`${label} is required.`);
  return value;
}
