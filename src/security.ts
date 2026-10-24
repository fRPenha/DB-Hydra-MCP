import { createHash } from "node:crypto";

export interface AuditEntryInput {
  toolName: string;
  profileName: string;
  query: string;
  durationMs: number;
  rowCount: number;
  success: boolean;
}

export interface AuditEntry {
  toolName: string;
  profileName: string;
  queryHash: string;
  querySummary: string;
  durationMs: number;
  rowCount: number;
  success: boolean;
}

// Allowlist: one SELECT/WITH statement. Deny list: words that write, lock, change
// session state or reach files, network, credentials. A read-only transaction in
// main.ts is the second layer; neither replaces a read-only database user.
const DENIED_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "ALTER", "DROP", "CREATE", "TRUNCATE",
  "RENAME", "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE", "BEGIN", "DECLARE", "COMMIT",
  "ROLLBACK", "SAVEPOINT", "INTO", "LOCK", "SHARE", "COPY", "SET", "SHOW", "KILL", "LOAD",
  "HANDLER", "PREPARE", "DEALLOCATE", "LISTEN", "NOTIFY", "VACUUM", "ANALYZE",
  "SET_CONFIG", "LOAD_FILE", "SLEEP", "BENCHMARK", "GET_LOCK", "RELEASE_LOCK",
  "PG_AUTHID", "PG_SHADOW", "PG_USER_MAPPING", "PG_USER_MAPPINGS", "MYSQL",
  "USER$", "LINK$", "DBA_USERS", "CDB_USERS", "HTTPURITYPE", "CTXSYS", "ORDSYS",
  "OPENROWSET", "OPENQUERY", "OPENDATASOURCE",
]);

const DENIED_PREFIXES = [
  "PG_READ", "PG_LS_", "PG_STAT_FILE", "PG_FILE", "PG_TERMINATE", "PG_CANCEL", "PG_SLEEP",
  "PG_RELOAD", "PG_ROTATE", "PG_ADVISORY", "PG_LOGICAL", "PG_REPLICATION", "PG_CREATE",
  "PG_DROP", "PG_BACKUP", "PG_START", "PG_STOP", "PG_PROMOTE", "PG_SWITCH", "PG_IMPORT",
  "LO_", "DBLINK", "QUERY_TO_", "CURSOR_TO_", "DBMS_", "UTL_", "XP_",
];

// Prefixes that turn the next quote into an alternative string syntax.
const DENIED_STRING_PREFIXES = new Set(["Q", "NQ", "E"]);

function reject(profileName: string, reason: string): never {
  throw new Error(`Profile ${profileName} is read-only and rejected the query: ${reason}`);
}

function readQuoted(query: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < query.length) {
    const char = query[i];
    if (backslashEscapes && char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) {
      if (query[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

// ponytail: lexer, not a parser; it fails closed on syntax it does not understand.
function tokenizeWords(profileName: string, query: string, engine: string): string[] {
  const words: string[] = [];
  const isMariaDb = engine === "mariadb";
  let i = 0;
  let afterSemicolon = false;

  while (i < query.length) {
    const char = query[i];
    const next = query[i + 1];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = query.indexOf("\n", i);
      i = end === -1 ? query.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      if (query[i + 2] === "!") reject(profileName, "executable comment");
      const end = query.indexOf("*/", i + 2);
      if (end === -1) reject(profileName, "unterminated comment");
      i = end + 2;
      continue;
    }
    if (afterSemicolon) reject(profileName, "multiple statements");
    if (char === ";") {
      afterSemicolon = true;
      i += 1;
      continue;
    }
    if (char === "'") {
      const end = readQuoted(query, i, "'", isMariaDb);
      if (end === -1) reject(profileName, "unterminated string");
      i = end;
      continue;
    }
    if (char === "\"" || (isMariaDb && char === "`")) {
      const end = readQuoted(query, i, char, isMariaDb && char === "\"");
      if (end === -1) reject(profileName, "unterminated identifier");
      // Quoted identifiers resolve to objects, so they go through the deny list too.
      words.push(query.slice(i + 1, end - 1).toUpperCase());
      i = end;
      continue;
    }
    if (char === "$" || char === "#" || char === "@" || char === "\\") {
      reject(profileName, `character ${char} outside a string`);
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(query.slice(i));
    if (word) {
      const upper = word[0].toUpperCase();
      const after = query[i + word[0].length];
      if (after === "'" && DENIED_STRING_PREFIXES.has(upper)) {
        reject(profileName, `string syntax ${upper}''`);
      }
      if (upper === "U" && after === "&") reject(profileName, "string syntax U&");
      words.push(upper);
      i += word[0].length;
      continue;
    }
    i += 1;
  }

  return words;
}

export function enforceReadOnlyPolicy(profileName: string, query: string, engine = ""): void {
  const words = tokenizeWords(profileName, query, engine.toLowerCase());
  if (words[0] !== "SELECT" && words[0] !== "WITH") {
    reject(profileName, "only SELECT or WITH is allowed");
  }
  for (const word of words) {
    if (DENIED_WORDS.has(word) || DENIED_PREFIXES.some((prefix) => word.startsWith(prefix))) {
      reject(profileName, `${word} is not allowed`);
    }
  }
}

function normalizeQueryForPolicy(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashQuerySummary(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export function summarizeQuery(query: string): string {
  const compact = normalizeQueryForPolicy(query);
  if (!compact) {
    return "query";
  }

  if (/^(metadata|procedure|tool):/i.test(compact)) {
    return compact;
  }

  const operation = compact.split(/\s+/, 1)[0]?.toUpperCase() ?? "QUERY";
  return `${operation} statement (${query.length} chars)`;
}

export function buildAuditEntry(input: AuditEntryInput): AuditEntry {
  return {
    toolName: input.toolName,
    profileName: input.profileName,
    queryHash: hashQuerySummary(input.query),
    querySummary: summarizeQuery(input.query),
    durationMs: input.durationMs,
    rowCount: input.rowCount,
    success: input.success,
  };
}
