import { CliError } from "../errors.js";
import { isInteractive, prompt, promptSecret, requireInteractive } from "./prompt.js";
import { loadCredentials, updateCredentials, type LlmCredentials } from "./store.js";

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

export function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl || DEFAULT_LLM_BASE_URL).trim().replace(/\/+$/, "");
  return value || DEFAULT_LLM_BASE_URL;
}

export async function configureLlm(): Promise<LlmCredentials> {
  requireInteractive("akg-debug auth llm");
  const existing = loadCredentials().llm;
  const baseUrl = normalizeBaseUrl(await prompt("OpenAI-compatible base URL", existing?.baseUrl ?? DEFAULT_LLM_BASE_URL));
  const apiKey = await promptSecret("Model API key");
  const credentials = { apiKey, baseUrl };
  updateCredentials({ llm: credentials });
  console.log(`Model credentials saved for ${baseUrl}.`);
  return credentials;
}

export async function ensureLlm(): Promise<LlmCredentials> {
  const existing = loadCredentials().llm;
  if (existing?.apiKey) {
    return { apiKey: existing.apiKey, baseUrl: normalizeBaseUrl(existing.baseUrl) };
  }
  if (!isInteractive()) {
    throw new CliError("Model credentials are missing. Run `akg-debug auth llm` and try again.");
  }
  return configureLlm();
}

export async function replaceLlmAfterRejection(): Promise<LlmCredentials> {
  if (!isInteractive()) {
    throw new CliError("The model API rejected the stored key. Run `akg-debug auth llm` and try again.");
  }
  console.error("The model API rejected the stored key. Enter it again.");
  return configureLlm();
}
