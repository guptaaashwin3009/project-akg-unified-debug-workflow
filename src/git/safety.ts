import path from "node:path";

export interface DiffSafetyOptions {
  allow?: string[];
  repoRoot?: string;
}

function unquote(value: string): string {
  let text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const tab = text.indexOf("\t");
  if (tab !== -1) text = text.slice(0, tab);
  return text;
}

function stripDiffPrefix(filePath: string): string {
  if (filePath === "/dev/null") return "";
  if (filePath.startsWith("a/") || filePath.startsWith("b/"))
    return filePath.slice(2);
  return filePath;
}

export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const add = (filePath: string) => {
    const stripped = stripDiffPrefix(unquote(filePath)).replace(/\\/g, "/");
    if (!stripped || stripped === "/dev/null") return;
    paths.add(stripped);
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const marker = " b/";
      const index = rest.lastIndexOf(marker);
      if (index !== -1) {
        add(rest.slice(0, index));
        add(rest.slice(index + " b/".length));
      }
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      add(line.slice(4));
    }
  }
  return [...paths];
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  const normalized = glob.replace(/\\/g, "/");
  let index = 0;
  while (index < normalized.length) {
    if (normalized.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (normalized.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = normalized[index];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  source += "$";
  return new RegExp(source);
}

export function matchesAllow(
  filePath: string,
  allow: string[] | undefined,
): boolean {
  if (!allow || allow.length === 0) return !allow;
  return allow.some((glob) => globToRegExp(glob).test(filePath));
}

export function diffPathProblem(
  filePath: string,
  options: DiffSafetyOptions = {},
): string | null {
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (!normalized) return "diff contains an empty path";
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return `absolute path ${normalized}`;
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.includes("..")) return `path traversal in ${normalized}`;
  if (parts.includes(".git")) return `.git path ${normalized}`;
  if (options.repoRoot) {
    const root = path.resolve(options.repoRoot);
    const resolved = path.resolve(root, ...parts);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `path ${normalized} escapes the repository`;
    }
  }
  if (options.allow && !matchesAllow(normalized, options.allow)) {
    return `path ${normalized} is outside the patch allowlist`;
  }
  return null;
}

/** Returns the first reason the diff must not be applied, or null when it is safe. */
export function unsafeDiffReason(
  diff: string,
  options: DiffSafetyOptions = {},
): string | null {
  const trimmed = diff.trim();
  if (!trimmed) return null;
  const paths = extractDiffPaths(trimmed);
  if (paths.length === 0) return "diff does not name any files";
  for (const filePath of paths) {
    const problem = diffPathProblem(filePath, options);
    if (problem) return problem;
  }
  return null;
}

export function assertSafeDiff(
  diff: string,
  options: DiffSafetyOptions = {},
): void {
  const reason = unsafeDiffReason(diff, options);
  if (reason) {
    const error = new Error(`Rejected diff: ${reason}`);
    error.name = "UnsafeDiffError";
    throw error;
  }
}
