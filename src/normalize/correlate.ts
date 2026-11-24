import fs from "node:fs";
import path from "node:path";
import { stableSearchPhrases, type SignalGroup } from "./fingerprint.js";
import { resolveFrames } from "./stack.js";
import type { CodeExcerpt, Signal } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;
const MAX_EXCERPTS = 6;
const CONTEXT_LINES = 12;

function excerptAtLine(content: string, line: number): string {
  const lines = content.split(/\r?\n/);
  const index = Math.min(Math.max(line, 1), lines.length);
  const start = Math.max(0, index - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, index + CONTEXT_LINES);
  return lines
    .slice(start, end)
    .map(
      (text, offset) =>
        `${String(start + offset + 1).padStart(4, " ")} | ${text}`,
    )
    .join("\n")
    .slice(0, 4000);
}

function excerptAtIndex(
  content: string,
  index: number,
): { line: number; excerpt: string } {
  const lines = content.split(/\r?\n/);
  let cursor = 0;
  let line = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const next = cursor + lines[i].length + 1;
    if (index < next) {
      line = i + 1;
      break;
    }
    cursor = next;
  }
  return { line, excerpt: excerptAtLine(content, line) };
}

function walkFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(path.join(dir, entry.name));
    }
  };
  visit(repoRoot);
  return files;
}

function readText(filePath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 1000).includes(0)) return undefined;
  return buffer.toString("utf8");
}

export function correlateSignals(
  repoRoot: string,
  signals: Signal[],
  groups: SignalGroup[],
): CodeExcerpt[] {
  const excerpts: CodeExcerpt[] = [];
  const seen = new Set<string>();

  const add = (excerpt: CodeExcerpt) => {
    if (excerpts.length >= MAX_EXCERPTS) return;
    const key = `${excerpt.file}:${excerpt.line ?? 0}:${excerpt.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    excerpts.push(excerpt);
  };

  const texts = [
    ...groups.flatMap((group) => group.samples),
    ...signals.slice(0, 20),
  ];
  for (const signal of texts) {
    const blob = [signal.message, signal.stack].filter(Boolean).join("\n");
    for (const frame of resolveFrames(blob, repoRoot)) {
      const abs = path.join(repoRoot, frame.file);
      const content = readText(abs);
      if (!content) continue;
      add({
        file: frame.file,
        line: frame.line,
        reason: `stack frame ${frame.raw}`,
        excerpt: excerptAtLine(content, frame.line),
      });
    }
  }

  const phrases = new Set<string>();
  for (const group of groups) {
    for (const sample of group.samples) {
      for (const phrase of stableSearchPhrases(sample.message))
        phrases.add(phrase);
    }
  }

  if (phrases.size && excerpts.length < MAX_EXCERPTS) {
    for (const filePath of walkFiles(repoRoot)) {
      if (excerpts.length >= MAX_EXCERPTS) break;
      const content = readText(filePath);
      if (!content) continue;
      for (const phrase of phrases) {
        const index = content.indexOf(phrase);
        if (index === -1) continue;
        const relative = path
          .relative(repoRoot, filePath)
          .split(path.sep)
          .join("/");
        const located = excerptAtIndex(content, index);
        add({
          file: relative,
          line: located.line,
          reason: `matched error text "${phrase.slice(0, 80)}"`,
          excerpt: located.excerpt,
        });
        break;
      }
    }
  }

  return excerpts;
}
