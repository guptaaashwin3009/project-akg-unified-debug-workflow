import { CliError } from "../errors.js";
import { confirm, isInteractive, prompt, promptSecret, requireInteractive } from "./prompt.js";
import { loadCredentials, updateCredentials, type GrafanaCredentials } from "./store.js";

/** Strip a trailing slash, userinfo, and query so the stored base URL cannot carry the token. */
export function normalizeGrafanaBaseUrl(input: string | undefined): string {
  let value = (input || "").trim();
  if (!value) throw new CliError("Grafana base URL is required.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("Grafana base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("Grafana base URL must start with http:// or https://.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function grafanaHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "Grafana";
  } catch {
    return "Grafana";
  }
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function grafanaGet(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { method: "GET", headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not reach Grafana to validate credentials: ${message}`);
  }
}

export async function validateGrafana(credentials: GrafanaCredentials): Promise<"ok" | "unauthorized"> {
  const base = normalizeGrafanaBaseUrl(credentials.baseUrl);
  const health = await grafanaGet(`${base}/api/health`, { Accept: "application/json" });
  if (health.status === 401 || health.status === 403) {
    const authed = await grafanaGet(`${base}/api/health`, bearerHeaders(credentials.token));
    if (authed.status === 401 || authed.status === 403) return "unauthorized";
    if (!authed.ok) throw new CliError(`Grafana health check failed with HTTP ${authed.status}.`);
    return "ok";
  }
  if (!health.ok) throw new CliError(`Grafana health check failed with HTTP ${health.status}.`);

  const user = await grafanaGet(`${base}/api/user`, bearerHeaders(credentials.token));
  if (user.status === 401 || user.status === 403) return "unauthorized";
  if (!user.ok) throw new CliError(`Grafana token check failed with HTTP ${user.status}.`);
  return "ok";
}

function normalizedCredentials(credentials: GrafanaCredentials): GrafanaCredentials {
  const orgId = credentials.orgId?.trim();
  return {
    baseUrl: normalizeGrafanaBaseUrl(credentials.baseUrl),
    token: credentials.token,
    ...(orgId ? { orgId } : {}),
  };
}

async function promptGrafanaCredentials(existing?: GrafanaCredentials): Promise<GrafanaCredentials> {
  requireInteractive("akg-debug auth grafana");
  const baseUrl = normalizeGrafanaBaseUrl(await prompt("Grafana base URL", existing?.baseUrl));
  const token = await promptSecret("Grafana service account or API token");
  const orgId = (await prompt("Grafana org id (optional)", existing?.orgId)).trim();
  return normalizedCredentials({ baseUrl, token, ...(orgId ? { orgId } : {}) });
}

export async function configureGrafana(): Promise<GrafanaCredentials> {
  requireInteractive("akg-debug auth grafana");
  const existing = loadCredentials().grafana;
  let credentials = await promptGrafanaCredentials(existing);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await validateGrafana(credentials);
    if (result === "ok") {
      updateCredentials({ grafana: credentials });
      console.log(`Grafana credentials saved for ${grafanaHost(credentials.baseUrl)}.`);
      return credentials;
    }
    console.error("Grafana rejected that token.");
    if (attempt === 2) {
      throw new CliError("Grafana rejected the token. Run `akg-debug auth grafana` to try again.");
    }
    const again = await confirm("Enter the Grafana token again?");
    if (!again) throw new CliError("Grafana credentials were not saved.");
    credentials = await promptGrafanaCredentials(credentials);
  }
  throw new CliError("Grafana credentials were not saved.");
}

export async function ensureGrafana(): Promise<GrafanaCredentials> {
  let credentials = loadCredentials().grafana;
  if (!credentials?.baseUrl || !credentials.token) {
    if (!isInteractive()) {
      throw new CliError("Grafana credentials are missing. Run `akg-debug auth grafana` and try again.");
    }
    credentials = await configureGrafana();
  }
  credentials = normalizedCredentials(credentials);
  const result = await validateGrafana(credentials);
  if (result === "unauthorized") {
    if (!isInteractive()) {
      throw new CliError("Grafana rejected the stored token. Run `akg-debug auth grafana` and try again.");
    }
    console.error("Grafana rejected the stored token. Enter it again.");
    return configureGrafana();
  }
  updateCredentials({ grafana: credentials });
  return credentials;
}

export async function replaceGrafanaAfterRejection(): Promise<GrafanaCredentials> {
  if (!isInteractive()) {
    throw new CliError("Grafana rejected the stored token. Run `akg-debug auth grafana` and try again.");
  }
  console.error("Grafana rejected the stored token. Enter it again.");
  return configureGrafana();
}
