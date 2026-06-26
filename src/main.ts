import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import odbc from "odbc";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProfileRegistry,
  getSafeProfileMetadata,
  resolveProfileSelection,
  type DatabaseProfile,
} from "./config.js";
import { buildAuditEntry, enforceReadOnlyPolicy } from "./security.js";
import { formatRows, sanitizeErrorMessage } from "./output.js";
import { loadEnvironment } from "./env.js";
import { hasVirtuosoProfile, registerVirtuosoTools } from "./virtuoso-tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface OdbcTableRow {
  TABLE_QUALIFIER?: string;
  TABLE_OWNER?: string;
  TABLE_NAME: string;
  [key: string]: unknown;
}

interface QueryExecutionOptions {
  toolName: string;
  profileName?: string;
  query: string;
  format?: string;
}

interface RowsExecutionOptions {
  toolName: string;
  profileName?: string;
  format?: string;
  auditQuery: string;
  operation: (connection: odbc.Connection, profile: DatabaseProfile) => Promise<Array<Record<string, unknown>>>;
}

interface ScalarExecutionOptions {
  toolName: string;
  profileName?: string;
  auditQuery: string;
  operation: (connection: odbc.Connection, profile: DatabaseProfile) => Promise<string>;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${sanitizeErrorMessage(error)}` }],
    isError: true,
  };
}

function normalizeRows(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows as Array<Record<string, unknown>>;
}

function clampRows<T>(rows: T[], maxRows: number): T[] {
  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

async function closeConnection(connection?: odbc.Connection): Promise<void> {
  if (!connection) {
    return;
  }

  try {
    await connection.close();
  } catch (_) {
    // Intentionally ignore close errors to preserve current behavior.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withProfileConnection<T>(
  profile: DatabaseProfile,
  operation: (connection: odbc.Connection) => Promise<T>,
): Promise<T> {
  let connection: odbc.Connection | undefined;
  try {
    connection = await odbc.connect(`DSN=${profile.dsn};UID=${profile.user};PWD=${profile.password}`);
    return await operation(connection);
  } finally {
    await closeConnection(connection);
  }
}

function logAudit(
  toolName: string,
  profileName: string,
  query: string,
  durationMs: number,
  rowCount: number,
  success: boolean,
): void {
  const entry = buildAuditEntry({
    toolName,
    profileName,
    query,
    durationMs,
    rowCount,
    success,
  });

  const output = success ? console.log : console.error;
  output(JSON.stringify(entry));
}

async function supportsCatalogs(connection: odbc.Connection): Promise<boolean> {
  try {
    const catalogs = await connection.tables("%", "", "", null) as OdbcTableRow[];
    return Boolean(catalogs.length && catalogs[0].TABLE_QUALIFIER);
  } catch (_) {
    return false;
  }
}

async function executeRowsTool({
  toolName,
  profileName,
  format = "json",
  auditQuery,
  operation,
}: RowsExecutionOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  let auditProfileName = profileName ?? profileRegistry.defaultProfileName ?? "unknown";

  try {
    const profile = resolveProfileSelection(profileRegistry, profileName);
    auditProfileName = profile.name;
    const rows = await withProfileConnection(profile, async (connection) => {
      const result = await withTimeout(operation(connection, profile), profile.timeoutMs, toolName);
      return clampRows(normalizeRows(result), profile.maxRows);
    });

    logAudit(toolName, profile.name, auditQuery, Date.now() - startedAt, rows.length, true);
    return textResult(formatRows(rows, format));
  } catch (error) {
    logAudit(toolName, auditProfileName, auditQuery, Date.now() - startedAt, 0, false);
    return errorResult(error);
  }
}

async function executeQueryTool({
  toolName,
  profileName,
  query,
  format = "json",
}: QueryExecutionOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  let auditProfileName = profileName ?? profileRegistry.defaultProfileName ?? "unknown";

  try {
    const profile = resolveProfileSelection(profileRegistry, profileName);
    auditProfileName = profile.name;
    enforceReadOnlyPolicy(profile.name, query);
    const rows = await withProfileConnection(profile, async (connection) => {
      const result = await withTimeout(connection.query(query), profile.timeoutMs, toolName);
      return clampRows(normalizeRows(result), profile.maxRows);
    });

    logAudit(toolName, profile.name, query, Date.now() - startedAt, rows.length, true);
    return textResult(formatRows(rows, format));
  } catch (error) {
    logAudit(toolName, auditProfileName, query, Date.now() - startedAt, 0, false);
    return errorResult(error);
  }
}

async function executeScalarTool({
  toolName,
  profileName,
  auditQuery,
  operation,
}: ScalarExecutionOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  let auditProfileName = profileName ?? profileRegistry.defaultProfileName ?? "unknown";

  try {
    const profile = resolveProfileSelection(profileRegistry, profileName);
    auditProfileName = profile.name;
    const result = await withProfileConnection(profile, async (connection) => {
      return withTimeout(operation(connection, profile), profile.timeoutMs, toolName);
    });

    logAudit(toolName, profile.name, auditQuery, Date.now() - startedAt, 1, true);
    return textResult(result);
  } catch (error) {
    logAudit(toolName, auditProfileName, auditQuery, Date.now() - startedAt, 0, false);
    return errorResult(error);
  }
}

const env = loadEnvironment(path.join(projectRoot, ".env"));
const profileRegistry = createProfileRegistry(env);
const API_KEY = env.API_KEY ?? "none";

const server = new McpServer({
  name: "DB Hydra MCP",
  version: "1.1.0",
});

const profileParam = { profile: profileRegistry.legacyMode ? z.string().optional() : z.string() };
const formatParam = { format: z.string().optional() };

server.tool(
  "list_profiles",
  "List configured database profiles without exposing credentials.",
  { ...formatParam },
  async ({ format = "json" }) => {
    const profiles = profileRegistry.profileNames.map((name) =>
      getSafeProfileMetadata(profileRegistry.profiles.get(name)),
    );

    return textResult(formatRows(profiles as unknown as Array<Record<string, unknown>>, format));
  },
);

server.tool(
  "describe_profile",
  "Describe one configured database profile without exposing credentials.",
  { profile: z.string() },
  async ({ profile }) => {
    try {
      const selected = resolveProfileSelection(profileRegistry, profile);
      return textResult(JSON.stringify(getSafeProfileMetadata(selected), null, 2));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "get_schemas",
  "Retrieve and return a list of all schema names from the connected database.",
  { ...profileParam, ...formatParam },
  async ({ profile, format = "json" }) =>
    executeRowsTool({
      toolName: "get_schemas",
      profileName: profile,
      format,
      auditQuery: "metadata:get_schemas",
      operation: async (connection) => {
        const hasCatalogs = await supportsCatalogs(connection);
        const result = hasCatalogs
          ? await connection.tables("%", "", "", null)
          : await connection.tables(null, "%", "", null);

        let columnName = "TABLE_CAT";
        if (result.length > 0) {
          const firstRow = result[0] as Record<string, unknown>;
          if (hasCatalogs) {
            columnName = "TABLE_CAT" in firstRow ? "TABLE_CAT" : "TABLE_QUALIFIER";
          } else {
            columnName = "TABLE_SCHEM" in firstRow ? "TABLE_SCHEM" : "TABLE_OWNER";
          }
        }

        const normalizedResult = normalizeRows(result);
        return [...new Set(normalizedResult.map((item) => item[columnName]))]
          .filter((name) => name !== undefined && name !== null)
          .map((name) => ({ CATALOG_NAME: name }));
      },
    }),
);

server.tool(
  "get_tables",
  "Retrieve and return a list containing information about tables in specified schema, if empty uses connection default.",
  { schema: z.string().optional(), ...profileParam, ...formatParam },
  async ({ schema, profile, format = "json" }) =>
    executeRowsTool({
      toolName: "get_tables",
      profileName: profile,
      format,
      auditQuery: "metadata:get_tables",
      operation: async (connection) => {
        const hasCatalogs = await supportsCatalogs(connection);
        return hasCatalogs
          ? normalizeRows(await connection.tables(schema ?? null, null, null, null))
          : normalizeRows(await connection.tables(null, schema ?? null, null, null));
      },
    }),
);

server.tool(
  "filter_table_names",
  "Retrieve and return a list containing information about tables whose names contain the substring q.",
  { q: z.string(), schema: z.string().optional(), ...profileParam, ...formatParam },
  async ({ q, schema, profile, format = "json" }) =>
    executeRowsTool({
      toolName: "filter_table_names",
      profileName: profile,
      format,
      auditQuery: `metadata:filter_table_names:${q}`,
      operation: async (connection) => {
        const hasCatalogs = await supportsCatalogs(connection);
        const data = hasCatalogs
          ? normalizeRows(await connection.tables(schema ?? "%", null, "%", null))
          : normalizeRows(await connection.tables(null, schema ?? "%", "%", null));

        return data.filter((row) => String(row.TABLE_NAME ?? "").includes(q));
      },
    }),
);

server.tool(
  "describe_table",
  "Retrieve and return a definition of a table, including column names, data types, nullable, autoincrement, primary key, and foreign keys.",
  { schema: z.string(), table: z.string(), ...profileParam, ...formatParam },
  async ({ schema, table, profile, format = "json" }) =>
    executeRowsTool({
      toolName: "describe_table",
      profileName: profile,
      format,
      auditQuery: `metadata:describe_table:${schema}.${table}`,
      operation: async (connection) => {
        const hasCatalogs = await supportsCatalogs(connection);
        return hasCatalogs
          ? normalizeRows(await connection.columns(schema, null, table, null))
          : normalizeRows(await connection.columns(null, schema, table, null));
      },
    }),
);

server.tool(
  "query_database",
  "Execute a SQL query and return results in JSON, JSONL or MD format.",
  { query: z.string(), ...profileParam, ...formatParam },
  async ({ query, profile, format = "json" }) =>
    executeQueryTool({
      toolName: "query_database",
      profileName: profile,
      query,
      format,
    }),
);

server.tool(
  "query_database_md",
  "Execute a SQL query and return results in MD format.",
  { query: z.string(), ...profileParam },
  async ({ query, profile }) =>
    executeQueryTool({
      toolName: "query_database_md",
      profileName: profile,
      query,
      format: "md",
    }),
);

server.tool(
  "query_database_jsonl",
  "Execute a SQL query and return results in JSONL format.",
  { query: z.string(), ...profileParam },
  async ({ query, profile }) =>
    executeQueryTool({
      toolName: "query_database_jsonl",
      profileName: profile,
      query,
      format: "jsonl",
    }),
);


if (hasVirtuosoProfile([...profileRegistry.profiles.values()])) {
  registerVirtuosoTools({
    server,
    profileParam,
    formatParam,
    apiKey: API_KEY,
    executeRowsTool,
    executeQueryTool,
    executeScalarTool,
    normalizeRows,
    enforceReadOnlyPolicy,
    withTimeout,
  });
}

const transport = new StdioServerTransport();
server.connect(transport);
