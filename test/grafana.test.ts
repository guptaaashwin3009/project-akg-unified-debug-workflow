import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeGrafanaBaseUrl } from "../src/auth/grafana.js";
import type { GrafanaCredentials } from "../src/auth/store.js";
import {
  GRAFANA_LOG_LIMIT,
  buildGrafanaQueryRangeUrl,
  grafanaLokiHeaders,
  signalsFromLokiResponse,
} from "../src/collectors/grafana.js";
import { loadTeamConfig, parseSince, resolveInvestigateConfig, shouldQueryGrafana } from "../src/config.js";

test("since 1h builds Loki query_range start and end in nanoseconds", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const window = parseSince("1h", now);
  const query = '{app="payments-api"}';
  const built = buildGrafanaQueryRangeUrl({
    baseUrl: "https://grafana.example.com/",
    datasourceUid: "loki",
    query,
    from: window.from,
    to: window.to,
  });
  const url = new URL(built);

  assert.equal(
    `${url.origin}${url.pathname}`,
    "https://grafana.example.com/api/datasources/proxy/uid/loki/loki/api/v1/query_range",
  );
  assert.equal(url.searchParams.get("query"), query);
  assert.equal(url.search.includes("status:"), false);
  assert.equal(url.searchParams.get("limit"), String(GRAFANA_LOG_LIMIT));

  const start = BigInt(url.searchParams.get("start") ?? "0");
  const end = BigInt(url.searchParams.get("end") ?? "0");
  assert.equal(end, BigInt(now) * 1_000_000n);
  assert.equal(start, BigInt(Date.parse(window.from)) * 1_000_000n);
  assert.equal(end - start, 3_600_000n * 1_000_000n);
});

test("Loki query_range payload becomes grafana signals", () => {
  const payload = {
    status: "success",
    data: {
      resultType: "streams",
      result: [
        {
          stream: { app: "payments-api", level: "error", namespace: "payments" },
          values: [["1735689600000000000", "connection refused while charging card"]],
        },
        {
          stream: { app: "payments-api", detected_level: "warn", namespace: "payments" },
          values: [["1735689660000000000", "slow query"]],
        },
        {
          stream: { job: "payments-api", pod: "payments-api-abc" },
          values: [
            ["1735689720000000000", "panic: nil pointer"],
            ["1735689780000000000", "listening on :8080"],
          ],
        },
      ],
    },
  };

  const signals = signalsFromLokiResponse(payload, "fallback");
  assert.equal(signals.length, 4);
  assert.equal(signals[0].source, "grafana");
  assert.equal(signals[0].message, "connection refused while charging card");
  assert.equal(signals[0].severity, "error");
  assert.equal(signals[0].service, "payments-api");
  assert.equal(signals[0].timestamp, "2025-01-01T00:00:00.000Z");
  assert.equal(signals[0].attributes.app, "payments-api");
  assert.equal(signals[0].attributes.level, "error");
  assert.equal(signals[0].attributes.namespace, "payments");
  assert.equal(signals[1].severity, "warning");
  assert.equal(signals[1].attributes.detected_level, "warn");
  assert.equal(signals[2].severity, "error");
  assert.equal(signals[2].message, "panic: nil pointer");
  assert.equal(signals[2].service, "payments-api");
  assert.equal(signals[2].attributes.pod, "payments-api-abc");
  assert.equal(signals[3].severity, "info");
  assert.equal(signals[3].message, "listening on :8080");
});

test("grafana log lines are capped like Kubernetes logs", () => {
  const base = 1735689600000000000n;
  const values = Array.from({ length: GRAFANA_LOG_LIMIT + 1 }, (_, index) => [
    (base + BigInt(index) * 1_000_000_000n).toString(),
    `line ${index}`,
  ]);
  const signals = signalsFromLokiResponse(
    { data: { result: [{ stream: { app: "payments-api" }, values }] } },
    "payments-api",
  );
  assert.equal(signals.length, GRAFANA_LOG_LIMIT);
  assert.equal(signals[0].message, "line 1");
  assert.equal(signals.at(-1)?.message, `line ${GRAFANA_LOG_LIMIT}`);
});

test("yaml grafana query is overridden by --grafana-query", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "akg-debug-grafana-"));
  fs.writeFileSync(
    path.join(repo, ".akg-debug.yml"),
    [
      "service: payments-api",
      "datadog:",
      "  query: service:payments-api env:prod",
      "grafana:",
      "  datasourceUid: loki",
      '  query: \'{app="payments-api"} |= "error"\'',
      "k8s:",
      "  namespace: payments",
      "",
    ].join("\n"),
  );
  const team = loadTeamConfig(repo);
  const resolved = resolveInvestigateConfig(
    repo,
    { grafanaQuery: '{app="payments-api"} |= "timeout"', grafanaDatasource: "loki-prod" },
    team,
  );
  assert.equal(resolved.query, "service:payments-api env:prod");
  assert.equal(resolved.grafana?.query, '{app="payments-api"} |= "timeout"');
  assert.equal(resolved.grafana?.datasourceUid, "loki-prod");

  const queryOnly = resolveInvestigateConfig(
    repo,
    { grafanaQuery: '{app="payments-api"} |= "timeout"' },
    team,
  );
  assert.equal(queryOnly.grafana?.query, '{app="payments-api"} |= "timeout"');
  assert.equal(queryOnly.grafana?.datasourceUid, "loki");
});

test("investigate does not require Grafana when no grafana query is configured", () => {
  assert.equal(shouldQueryGrafana({}, {}), false);
  assert.equal(shouldQueryGrafana({ grafanaQuery: "  " }, { datadog: { query: "service:payments-api" } }), false);
  assert.equal(shouldQueryGrafana({ grafanaQuery: '{app="payments-api"} |= "error"' }, {}), true);
  assert.equal(shouldQueryGrafana({}, { grafana: { datasourceUid: "loki", query: '{app="x"}' } }), true);

  const resolved = resolveInvestigateConfig(
    "/repo",
    { service: "payments-api", namespace: "payments", query: "service:payments-api" },
    {},
  );
  assert.equal(resolved.grafana, undefined);
});

test("grafana base URL drops a trailing slash and org id is sent only when stored", () => {
  assert.equal(normalizeGrafanaBaseUrl("https://grafana.example.com/"), "https://grafana.example.com");
  const withoutOrg: GrafanaCredentials = { baseUrl: "https://grafana.example.com", token: "token" };
  assert.equal(grafanaLokiHeaders(withoutOrg)["X-Scope-OrgID"], undefined);
  assert.equal(grafanaLokiHeaders({ ...withoutOrg, orgId: " 12 " })["X-Scope-OrgID"], "12");
});
