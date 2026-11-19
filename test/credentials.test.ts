import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { credentialsPath, saveCredentials } from "../src/auth/store.js";

test("credential store writes mode 0600 under a temp HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akg-debug-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    saveCredentials({
      datadog: {
        apiKey: "test-api-key",
        appKey: "test-app-key",
        site: "datadoghq.com",
      },
    });
    const filePath = credentialsPath();
    assert.equal(filePath, path.join(home, ".config", "akg-debug", "credentials.json"));
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { datadog?: { apiKey?: string } };
    assert.equal(parsed.datadog?.apiKey, "test-api-key");
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});
