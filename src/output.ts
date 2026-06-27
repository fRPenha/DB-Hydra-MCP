export type OutputFormat = "json" | "jsonl" | "md";

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
