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

const MUTATING_QUERY_PATTERN =
  /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|call|exec|execute|begin)\b/i;

function stripQuotedStrings(query: string): string {
  return query
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, "\"\"");
}

function stripComments(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

function normalizeQueryForPolicy(query: string): string {
  return stripQuotedStrings(stripComments(query)).replace(/\s+/g, " ").trim();
}

export function enforceReadOnlyPolicy(profileName: string, query: string): void {
  const normalizedQuery = normalizeQueryForPolicy(query);
  if (MUTATING_QUERY_PATTERN.test(normalizedQuery)) {
    throw new Error(`Profile ${profileName} is read-only and rejected a mutating statement`);
  }
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
