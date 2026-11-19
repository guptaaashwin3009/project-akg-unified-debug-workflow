import type { Signal } from "../types.js";

/** Strip ids, hex, numbers, and timestamps so equal error templates can group together. */
export function fingerprint(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FingerprintGroup {
  template: string;
  count: number;
  sample: string;
}

export function groupFingerprints(messages: string[], limit = 5): FingerprintGroup[] {
  const groups = new Map<string, FingerprintGroup>();
  for (const message of messages) {
    const template = fingerprint(message);
    const existing = groups.get(template);
    if (existing) existing.count += 1;
    else groups.set(template, { template, count: 1, sample: message });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.template.localeCompare(b.template)).slice(0, limit);
}

export interface SignalGroup {
  template: string;
  count: number;
  samples: Signal[];
}

export function groupSignals(signals: Signal[], limit = 5): SignalGroup[] {
  const groups = new Map<string, SignalGroup>();
  for (const signal of signals) {
    const template = fingerprint(signal.message);
    let group = groups.get(template);
    if (!group) {
      group = { template, count: 0, samples: [] };
      groups.set(template, group);
    }
    group.count += 1;
    if (group.samples.length < 3) group.samples.push(signal);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** A stable phrase suitable for a literal source search. */
export function stableSearchPhrases(message: string): string[] {
  const phrases: string[] = [];
  const quoted = message.matchAll(/["'`]([^"'`]{8,160})["'`]/g);
  for (const match of quoted) {
    const phrase = match[1].trim();
    if (phrase && !/^[\d\s-]+$/.test(phrase)) phrases.push(phrase);
  }
  const cleaned = fingerprint(message)
    .replace(/<(?:id|hex|n|ts)>/g, " ")
    .replace(/[^\w\s:./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 12) phrases.push(cleaned.slice(0, 160));
  return [...new Set(phrases)].slice(0, 3);
}
