import { CliError, DatadogUnauthorizedError } from "../errors.js";
import { confirm, isInteractive, prompt, promptSecret, requireInteractive } from "./prompt.js";
import { loadCredentials, updateCredentials, type DatadogCredentials } from "./store.js";

export const DEFAULT_DATADOG_SITE = "datadoghq.com";

export function normalizeDatadogSite(site: string | undefined): string {
  let value = (site || DEFAULT_DATADOG_SITE).trim();
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  value = value.replace(/^api\./, "");
  return value || DEFAULT_DATADOG_SITE;
}

export function datadogApiBase(site: string): string {
  return `https://api.${normalizeDatadogSite(site)}`;
}

export async function validateDatadog(credentials: DatadogCredentials): Promise<"ok" | "unauthorized"> {
  const url = `${datadogApiBase(credentials.site)}/api/v1/validate`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "DD-API-KEY": credentials.apiKey,
        "DD-APPLICATION-KEY": credentials.appKey,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not reach Datadog to validate credentials: ${message}`);
  }
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) {
    throw new CliError(`Datadog credential check failed with HTTP ${response.status}.`);
  }
  return "ok";
}

async function promptDatadogCredentials(existing?: DatadogCredentials): Promise<DatadogCredentials> {
  requireInteractive("akg-debug auth datadog");
  const site = normalizeDatadogSite(await prompt("Datadog site", existing?.site ?? DEFAULT_DATADOG_SITE));
  const apiKey = await promptSecret("Datadog API key");
  const appKey = await promptSecret("Datadog application key");
  return { apiKey, appKey, site };
}

export async function configureDatadog(): Promise<DatadogCredentials> {
  requireInteractive("akg-debug auth datadog");
  const existing = loadCredentials().datadog;
  let credentials = await promptDatadogCredentials(existing);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await validateDatadog(credentials);
    if (result === "ok") {
      updateCredentials({ datadog: credentials });
      console.log(`Datadog credentials saved for ${credentials.site}.`);
      return credentials;
    }
    console.error("Datadog rejected those keys.");
    if (attempt === 2) {
      throw new CliError("Datadog rejected the keys. Run `akg-debug auth datadog` to try again.");
    }
    const again = await confirm("Enter Datadog keys again?");
    if (!again) throw new CliError("Datadog keys were not saved.");
    credentials = await promptDatadogCredentials(credentials);
  }
  throw new CliError("Datadog keys were not saved.");
}

export async function ensureDatadog(): Promise<DatadogCredentials> {
  let credentials = loadCredentials().datadog;
  if (!credentials?.apiKey || !credentials.appKey) {
    if (!isInteractive()) {
      throw new CliError("Datadog credentials are missing. Run `akg-debug auth datadog` and try again.");
    }
    credentials = await configureDatadog();
  }
  credentials = {
    ...credentials,
    site: normalizeDatadogSite(credentials.site),
  };
  const result = await validateDatadog(credentials);
  if (result === "unauthorized") {
    if (!isInteractive()) {
      throw new DatadogUnauthorizedError();
    }
    console.error("Datadog rejected the stored keys. Enter them again.");
    return configureDatadog();
  }
  updateCredentials({ datadog: credentials });
  return credentials;
}

export async function replaceDatadogAfterRejection(): Promise<DatadogCredentials> {
  if (!isInteractive()) {
    throw new CliError("Datadog rejected the stored keys. Run `akg-debug auth datadog` and try again.");
  }
  console.error("Datadog rejected the stored keys. Enter them again.");
  return configureDatadog();
}
