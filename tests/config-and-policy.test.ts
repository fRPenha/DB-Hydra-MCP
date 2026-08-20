import test from "node:test";
import assert from "node:assert/strict";

import {
  createProfileRegistry,
  getSafeProfileMetadata,
  resolveProfileSelection,
} from "../src/config.ts";
import {
  buildAuditEntry,
  enforceReadOnlyPolicy,
  hashQuerySummary,
} from "../src/security.ts";
import {
  formatRows,
  sanitizeErrorMessage,
} from "../src/output.ts";
import {
  loadEnvironment,
} from "../src/env.ts";
import {
  hasVirtuosoProfile,
  registerVirtuosoTools,
} from "../src/virtuoso-tools.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("createProfileRegistry loads named profiles and exposes only safe metadata", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "oracle_erp_hml,portal_backend_hml",
    MCP_ODBC_DEFAULT_PROFILE: "portal_backend_hml",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_LABEL: "Oracle ERP HML",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_ENGINE: "oracle",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_DSN: "Oracle-ERP-HML",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_USER: "secret-user",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_PASSWORD: "secret-password",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_READ_ONLY: "true",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_MAX_ROWS: "150",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_TIMEOUT_MS: "12000",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_LABEL: "Portal Backend HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_ENGINE: "postgresql",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_READ_ONLY: "true",
  });

  assert.equal(registry.defaultProfileName, "portal_backend_hml");
  assert.equal(registry.legacyMode, false);
  assert.deepEqual(registry.profileNames, ["oracle_erp_hml", "portal_backend_hml"]);

  const metadata = getSafeProfileMetadata(registry.profiles.get("oracle_erp_hml"));
  assert.deepEqual(metadata, {
    name: "oracle_erp_hml",
    label: "Oracle ERP HML",
    engine: "oracle",
    readOnly: true,
    maxRows: 150,
    timeoutMs: 12000,
    isDefault: false,
  });

  assert.equal(JSON.stringify(metadata).includes("secret"), false);
  assert.equal(JSON.stringify(metadata).includes("Oracle-ERP-HML"), false);
});

test("resolveProfileSelection falls back to configured default profile", () => {
  const registry = createProfileRegistry({
    ODBC_DSN: "LegacyDSN",
    ODBC_USER: "legacy_user",
    ODBC_PASSWORD: "legacy_password",
  });

  const resolved = resolveProfileSelection(registry, undefined);
  assert.equal(resolved.name, "default");
});

test("createProfileRegistry preserves legacy single-profile configuration", () => {
  const registry = createProfileRegistry({
    ODBC_DSN: "Legacy-Virtuoso",
    ODBC_USER: "demo",
    ODBC_PASSWORD: "demo",
  });

  assert.equal(registry.defaultProfileName, "default");
  assert.equal(registry.legacyMode, true);
  assert.deepEqual(registry.profileNames, ["default"]);

  const resolved = resolveProfileSelection(registry, undefined);
  assert.equal(resolved.name, "default");
  assert.equal(resolved.dsn, "Legacy-Virtuoso");
  assert.equal(resolved.readOnly, true);
});

test("resolveProfileSelection requires explicit profile in multi-profile mode", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "oracle_erp_hml,portal_backend_hml",
    MCP_ODBC_DEFAULT_PROFILE: "portal_backend_hml",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_DSN: "Oracle-ERP-HML",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_USER: "secret-user",
    MCP_ODBC_PROFILE_ORACLE_ERP_HML_PASSWORD: "secret-password",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
  });

  assert.throws(
    () => resolveProfileSelection(registry, undefined),
    /explicit profile/i,
  );
});

test("legacy fallback is not injected when named profiles are configured", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "portal_backend_hml",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
    ODBC_DSN: "LegacyDSN",
    ODBC_USER: "legacy_user",
    ODBC_PASSWORD: "legacy_password",
  });

  assert.deepEqual(registry.profileNames, ["portal_backend_hml"]);
  assert.equal(registry.profiles.has("default"), false);
});

test("createProfileRegistry enforces read-only even if false is configured", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "portal_backend_hml",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_READ_ONLY: "false",
  });

  assert.equal(registry.profiles.get("portal_backend_hml")?.readOnly, true);
});

test("createProfileRegistry isolates an invalid profile instead of crashing all profiles", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "broken_profile,portal_backend_hml",
    MCP_ODBC_DEFAULT_PROFILE: "portal_backend_hml",
    // broken_profile is missing DSN/USER/PASSWORD on purpose.
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
  });

  assert.deepEqual(registry.profileNames, ["portal_backend_hml"]);
  assert.equal(registry.profiles.has("broken_profile"), false);
  assert.equal(registry.profiles.has("portal_backend_hml"), true);
  assert.equal(registry.defaultProfileName, "portal_backend_hml");
});

test("createProfileRegistry drops an invalid default profile without crashing", () => {
  const registry = createProfileRegistry({
    MCP_ODBC_PROFILE_NAMES: "broken_default,portal_backend_hml",
    MCP_ODBC_DEFAULT_PROFILE: "broken_default",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN: "Portal-HML",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER: "portal-user",
    MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD: "portal-password",
  });

  assert.equal(registry.defaultProfileName, undefined);
  assert.deepEqual(registry.profileNames, ["portal_backend_hml"]);
});

test("createProfileRegistry throws only when no profile is valid at all", () => {
  assert.throws(
    () => createProfileRegistry({
      MCP_ODBC_PROFILE_NAMES: "broken_profile",
    }),
    /No valid profiles configured/,
  );
});

test("enforceReadOnlyPolicy rejects mutating SQL statements", () => {
  assert.throws(
    () => enforceReadOnlyPolicy("oracle_erp_hml", "update pnf set campo = 1"),
    /read-only/i,
  );
  assert.throws(
    () => enforceReadOnlyPolicy("oracle_erp_hml", "-- test\nDELETE FROM pnf"),
    /read-only/i,
  );
  assert.throws(
    () => enforceReadOnlyPolicy("oracle_erp_hml", "/* test */ UPDATE pnf SET campo = 1"),
    /read-only/i,
  );
});

test("hashQuerySummary and buildAuditEntry avoid leaking raw query text", () => {
  const query = "select * from pnf where chave = '123'";
  const hash = hashQuerySummary(query);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, query);

  const entry = buildAuditEntry({
    toolName: "query_database",
    profileName: "portal_backend_hml",
    query,
    durationMs: 87,
    rowCount: 12,
    success: true,
  });

  assert.equal(entry.toolName, "query_database");
  assert.equal(entry.profileName, "portal_backend_hml");
  assert.equal(entry.durationMs, 87);
  assert.equal(entry.rowCount, 12);
  assert.equal(entry.success, true);
  assert.equal("query" in entry, false);
  assert.equal(entry.queryHash.length, 64);
  assert.equal(entry.querySummary.includes("where chave"), false);
  assert.match(entry.querySummary, /^SELECT statement \(\d+ chars\)$/);

  const sparqlLikeEntry = buildAuditEntry({
    toolName: "sparql_list_entity_types",
    profileName: "portal_backend_hml",
    query: "PREFIX rdf: <http://example.com> SELECT * WHERE { ?s ?p ?o }",
    durationMs: 20,
    rowCount: 3,
    success: true,
  });
  assert.equal(sparqlLikeEntry.querySummary.includes("http://example.com"), false);
  assert.match(sparqlLikeEntry.querySummary, /^PREFIX statement \(\d+ chars\)$/);
});

test("formatRows preserves json, jsonl and md contracts", () => {
  const rows = [{ id: 1, nome: "cte" }];

  assert.equal(formatRows(rows, "json"), JSON.stringify(rows, null, 2));
  assert.equal(formatRows(rows, "jsonl"), JSON.stringify(rows[0]));
  assert.match(formatRows(rows, "md"), /\| id \| nome \|/);
});

test("sanitizeErrorMessage removes credentials and connection details", () => {
  const rawError = new Error(
    "Connect failed DSN=Local Virtuoso;UID=portal_user;PWD=portal_secret; query select * from pnf",
  );

  const sanitized = sanitizeErrorMessage(rawError);

  assert.equal(sanitized.includes("portal_secret"), false);
  assert.equal(sanitized.includes("portal_user"), false);
  assert.equal(sanitized.includes("Local Virtuoso"), false);
  assert.match(sanitized, /Connect failed/i);
});

test("loadEnvironment prefers MCP_ODBC_ENV_FILE and preserves existing process env", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-odbc-env-"));
  const envPath = path.join(tempDir, "profiles.env");

  fs.writeFileSync(
    envPath,
    [
      "MCP_ODBC_PROFILE_NAMES=portal_backend_hml",
      "MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN=Portal-HML",
      "MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER=file-user",
      "MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD=file-password",
    ].join("\n"),
  );

  process.env.MCP_ODBC_ENV_FILE = envPath;
  process.env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER = "process-user";

  const env = loadEnvironment("/path/ignored/by/override.env");

  assert.equal(env.MCP_ODBC_PROFILE_NAMES, "portal_backend_hml");
  assert.equal(env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_DSN, "Portal-HML");
  assert.equal(env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER, "process-user");
  assert.equal(process.env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD, "file-password");

  delete process.env.MCP_ODBC_ENV_FILE;
  delete process.env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_USER;
  delete process.env.MCP_ODBC_PROFILE_PORTAL_BACKEND_HML_PASSWORD;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("registerVirtuosoTools isolates vendor-specific tool registration", () => {
  const registeredTools: string[] = [];
  const fakeServer = {
    tool(name: string) {
      registeredTools.push(name);
    },
  };

  registerVirtuosoTools({
    server: fakeServer,
    profileParam: {},
    formatParam: {},
    apiKey: "local-key",
    executeRowsTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
    executeQueryTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
    executeScalarTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    normalizeRows: (rows) => rows,
    enforceReadOnlyPolicy: () => undefined,
    withTimeout: async (promise) => promise,
  });

  assert.deepEqual(registeredTools, [
    "virt_get_schemas",
    "spasql_query",
    "virtuoso_support_ai",
    "sparql_list_entity_types",
    "sparql_list_entity_types_detailed",
    "sparql_list_entity_types_samples",
    "sparql_list_ontologies",
    "chat_prompt_complete",
  ]);
});

test("hasVirtuosoProfile detects whether vendor-specific tools should be registered", () => {
  assert.equal(hasVirtuosoProfile([
    { engine: "oracle" },
    { engine: "postgresql" },
  ]), false);

  assert.equal(hasVirtuosoProfile([
    { engine: "oracle" },
    { engine: "virtuoso" },
  ]), true);
});
