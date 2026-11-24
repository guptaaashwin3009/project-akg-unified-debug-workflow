/** Shared evidence record. Later sources can emit this without changing diagnose, PR, or deploy. */
export type SignalSource = "datadog" | "grafana" | "k8s";

export interface Signal {
  source: SignalSource;
  timestamp: string;
  service: string;
  severity: string;
  message: string;
  attributes: Record<string, unknown>;
  stack?: string;
}

export type Confidence = "low" | "medium" | "high";

export interface Diagnosis {
  summary: string;
  evidence: string[];
  confidence: Confidence;
  rootCause: string;
  diff: string;
  testPlan: string[];
  deployNotes: string;
}

export interface CodeExcerpt {
  file: string;
  line?: number;
  reason: string;
  excerpt: string;
}

export type RunStatus = "diagnosed" | "pr-opened" | "apply-failed" | "deploy-dispatched";

export interface RunRecord {
  id: string;
  createdAt: string;
  repo: string;
  service: string;
  summary: string;
  diff: string;
  prUrl?: string;
  status: RunStatus;
  branch?: string;
  namespace?: string;
  diagnosis: Diagnosis;
}
