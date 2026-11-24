export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class DatadogUnauthorizedError extends Error {
  constructor() {
    super("Datadog rejected the API key or application key.");
    this.name = "DatadogUnauthorizedError";
  }
}

export class GrafanaUnauthorizedError extends Error {
  constructor() {
    super("Grafana rejected the API token.");
    this.name = "GrafanaUnauthorizedError";
  }
}

export class KubeAuthError extends Error {
  readonly contextName: string | undefined;

  constructor(contextName?: string) {
    super(
      contextName
        ? `Kubernetes authentication failed for context ${contextName}. Run your usual cluster login and retry.`
        : "Kubernetes authentication failed. Run your usual cluster login and retry.",
    );
    this.name = "KubeAuthError";
    this.contextName = contextName;
  }
}
