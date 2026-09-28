export type OutputFormat = "json" | "jsonl" | "md" | "tsv";

// Remove padding de CHAR (ex.: Protheus) e converte BigInt, que o JSON.stringify não aceita.
function compactValue(value: unknown): unknown {
  if (typeof value === "string") return value.trimEnd();
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

function compactRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, compactValue(value)])),
  );
}

function dataToTsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return "No results found.";
  }

  const columns = Object.keys(rows[0]);
  const cell = (value: unknown) => String(value ?? "").replace(/[\t\r\n]+/g, " ");

  return [columns.join("\t"), ...rows.map((row) => columns.map((column) => cell(row[column])).join("\t"))].join("\n");
}

function dataToMarkdown(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return "No results found.";
  }

  const columns = Object.keys(rows[0]);
  let table = `| ${columns.join(" | ")} |\n`;
  table += `| ${columns.map(() => "---").join(" | ")} |\n`;

  for (const row of rows) {
    table += `| ${columns.map((column) => String(row[column] ?? "")).join(" | ")} |\n`;
  }

  return table;
}

export function formatRows(
  rows: Array<Record<string, unknown>>,
  format: string = "json",
): string {
  rows = compactRows(rows);

  if (format === "tsv") {
    return dataToTsv(rows);
  }

  if (format === "jsonl") {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }

  if (format === "md") {
    return dataToMarkdown(rows);
  }

  return JSON.stringify(rows, null, 2);
}

export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : JSON.stringify(error, null, 2);

  return raw
    .replace(/DSN=.*?(?=;|$)/gi, "DSN=[redacted]")
    .replace(/UID=.*?(?=;|$)/gi, "UID=[redacted]")
    .replace(/PWD=.*?(?=;|$)/gi, "PWD=[redacted]");
}
