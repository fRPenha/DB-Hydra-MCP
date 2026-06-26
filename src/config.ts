type EnvMap = Record<string, string | undefined>;

export interface DatabaseProfile {
  name: string;
  label: string;
  engine: string;
  dsn: string;
  user: string;
  password: string;
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
  isDefault: boolean;
}

export interface SafeProfileMetadata {
  name: string;
  label: string;
  engine: string;
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
  isDefault: boolean;
}

export interface ProfileRegistry {
  defaultProfileName?: string;
  legacyMode: boolean;
  profileNames: string[];
  profiles: Map<string, DatabaseProfile>;
}

const DEFAULT_ENGINE = "odbc";
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const LEGACY_DEFAULT_PROFILE_NAME = "default";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric profile setting: ${value}`);
  }

  return parsed;
}

function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase();
}

function profileEnvKey(profileName: string, suffix: string): string {
  return `MCP_ODBC_PROFILE_${profileName.toUpperCase()}_${suffix}`;
}

function readRequired(env: EnvMap, key: string, profileName: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required setting ${key} for profile ${profileName}`);
  }

  return value;
}

export function createProfileRegistry(env: EnvMap): ProfileRegistry {
  const rawNames = env.MCP_ODBC_PROFILE_NAMES?.split(",")
    .map((item) => normalizeProfileName(item))
    .filter(Boolean) ?? [];
  const legacyProfileConfigured = rawNames.length === 0 && Boolean(
    env.ODBC_DSN?.trim() && env.ODBC_USER?.trim() && env.ODBC_PASSWORD?.trim(),
  );

  if (rawNames.length === 0 && !legacyProfileConfigured) {
    throw new Error("No profiles configured in MCP_ODBC_PROFILE_NAMES");
  }

  const defaultProfileName = env.MCP_ODBC_DEFAULT_PROFILE
    ? normalizeProfileName(env.MCP_ODBC_DEFAULT_PROFILE)
    : legacyProfileConfigured
      ? LEGACY_DEFAULT_PROFILE_NAME
      : undefined;

  const uniqueNames = [...new Set(
    legacyProfileConfigured ? [...rawNames, LEGACY_DEFAULT_PROFILE_NAME] : rawNames,
  )].sort();
  const profiles = new Map<string, DatabaseProfile>();

  for (const profileName of uniqueNames) {
    const isLegacyProfile = profileName === LEGACY_DEFAULT_PROFILE_NAME && legacyProfileConfigured;
    const profile: DatabaseProfile = {
      name: profileName,
      label: isLegacyProfile
        ? "Default"
        : env[profileEnvKey(profileName, "LABEL")]?.trim() || profileName,
      engine: isLegacyProfile
        ? env.ODBC_ENGINE?.trim() || DEFAULT_ENGINE
        : env[profileEnvKey(profileName, "ENGINE")]?.trim() || DEFAULT_ENGINE,
      dsn: isLegacyProfile
        ? readRequired(env, "ODBC_DSN", profileName)
        : readRequired(env, profileEnvKey(profileName, "DSN"), profileName),
      user: isLegacyProfile
        ? readRequired(env, "ODBC_USER", profileName)
        : readRequired(env, profileEnvKey(profileName, "USER"), profileName),
      password: isLegacyProfile
        ? readRequired(env, "ODBC_PASSWORD", profileName)
        : readRequired(env, profileEnvKey(profileName, "PASSWORD"), profileName),
      readOnly: true,
      maxRows: isLegacyProfile
        ? parseNumber(env.ODBC_MAX_ROWS, DEFAULT_MAX_ROWS)
        : parseNumber(env[profileEnvKey(profileName, "MAX_ROWS")], DEFAULT_MAX_ROWS),
      timeoutMs: isLegacyProfile
        ? parseNumber(env.ODBC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
        : parseNumber(env[profileEnvKey(profileName, "TIMEOUT_MS")], DEFAULT_TIMEOUT_MS),
      isDefault: profileName === defaultProfileName,
    };

    profiles.set(profileName, profile);
  }

  if (defaultProfileName && !profiles.has(defaultProfileName)) {
    throw new Error(`Default profile not found: ${defaultProfileName}`);
  }

  return {
    defaultProfileName,
    legacyMode: legacyProfileConfigured,
    profileNames: uniqueNames,
    profiles,
  };
}

export function getSafeProfileMetadata(profile?: DatabaseProfile): SafeProfileMetadata {
  if (!profile) {
    throw new Error("Profile not found");
  }

  return {
    name: profile.name,
    label: profile.label,
    engine: profile.engine,
    readOnly: profile.readOnly,
    maxRows: profile.maxRows,
    timeoutMs: profile.timeoutMs,
    isDefault: profile.isDefault,
  };
}

export function resolveProfileSelection(
  registry: ProfileRegistry,
  requestedProfileName?: string,
): DatabaseProfile {
  if (!requestedProfileName && !registry.legacyMode) {
    throw new Error("An explicit profile is required for this server configuration");
  }

  const selectedName = requestedProfileName
    ? normalizeProfileName(requestedProfileName)
    : registry.defaultProfileName;

  if (!selectedName) {
    throw new Error("No profile selected and no default profile configured");
  }

  const profile = registry.profiles.get(selectedName);
  if (!profile) {
    throw new Error(`Unknown profile: ${selectedName}`);
  }

  return profile;
}
