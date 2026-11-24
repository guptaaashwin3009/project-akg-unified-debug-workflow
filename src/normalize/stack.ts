import fs from "node:fs";
import path from "node:path";

export interface StackCandidate {
  file: string;
  line: number;
  raw: string;
}

export interface ResolvedFrame {
  file: string;
  line: number;
  raw: string;
}

const FRAME_PATTERNS = [
  /at\s+(?:async\s+)?(?:[\w$.<>]+\s+)?\(?([^\s():]+\.(?:[cm]?js|jsx|tsx?)):(\d+):\d+\)?/g,
  /File ["']([^"']+\.py)["'], line (\d+)/g,
  /(?:^|\s)(\S+\.go):(\d+)\b/g,
];

export function findStackFrames(text: string): StackCandidate[] {
  const found: StackCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of FRAME_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const file = match[1].replace(/\\/g, "/");
      const line = Number(match[2]);
      if (!file || !Number.isFinite(line)) continue;
      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ file, line, raw: match[0].trim() });
    }
  }
  return found;
}

function defaultExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return (
    resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)
  );
}

function relativePosix(root: string, absPath: string): string {
  return path
    .relative(path.resolve(root), path.resolve(absPath))
    .split(path.sep)
    .join("/");
}

function skipped(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (
    parts.includes("node_modules") ||
    parts.includes(".git") ||
    parts.includes("dist")
  );
}

/**
 * Map a stack path onto a file inside the repo.
 * Absolute paths win, then the full relative path, then shorter suffixes
 * so container paths like /app/src/handler.ts can still hit src/handler.ts.
 */
export function resolveRepoFile(
  candidate: string,
  repoRoot: string,
  exists: (absPath: string) => boolean = defaultExists,
): string | null {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const attempts: string[] = [];
  if (path.posix.isAbsolute(normalized) || path.isAbsolute(candidate)) {
    attempts.push(path.resolve(normalized));
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  for (let index = 0; index < parts.length; index += 1) {
    attempts.push(path.resolve(repoRoot, ...parts.slice(index)));
  }
  const seen = new Set<string>();
  for (const absPath of attempts) {
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    if (!insideRoot(repoRoot, absPath)) continue;
    const relativePath = relativePosix(repoRoot, absPath);
    if (!relativePath || skipped(relativePath)) continue;
    if (exists(absPath)) return relativePath;
  }
  return null;
}

export function resolveFrames(
  text: string,
  repoRoot: string,
  exists?: (absPath: string) => boolean,
): ResolvedFrame[] {
  const frames: ResolvedFrame[] = [];
  const seen = new Set<string>();
  for (const candidate of findStackFrames(text)) {
    const file = resolveRepoFile(candidate.file, repoRoot, exists);
    if (!file) continue;
    const key = `${file}:${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push({ file, line: candidate.line, raw: candidate.raw });
  }
  return frames;
}
