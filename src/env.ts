import dotenv from "dotenv";
import * as fs from "node:fs";

export function resolveEnvFilePath(defaultPath: string): string {
  const overridePath = process.env.MCP_ODBC_ENV_FILE?.trim();
  return overridePath || defaultPath;
}

export function loadEnvironment(defaultPath: string): Record<string, string | undefined> {
  const filePath = resolveEnvFilePath(defaultPath);
  let fileEnv: Record<string, string> = {};

  if (fs.existsSync(filePath)) {
    fileEnv = dotenv.parse(fs.readFileSync(filePath));
  }

  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    ...fileEnv,
    ...process.env,
  };
}
