/**
 * Builds the minimal environment passed to the detached Meet joiner subprocess.
 *
 * The joiner (`joiner.ts`) drives Chromium via Playwright and authenticates purely
 * through the pre-signed-in persistent Chrome profile (`data/sentinel-chrome-profile`).
 * It imports no config and reads no application secrets. Forwarding the parent's full
 * environment would leak every Slack/Anthropic/Metabase/GitHub/Notion/Google token into
 * a long-lived, detached process that never needs them.
 *
 * `buildJoinerEnv` returns a NEW object containing only an allowlist of non-secret
 * runtime variables that `node`/`npx tsx`/Chromium need to launch.
 */

/** Exact runtime keys that are safe to forward (when present in the parent env). */
const ALLOWED_KEYS: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "USER",
  "SHELL",
  "PWD",
];

/** Key prefixes that are safe to forward (Chromium / Playwright runtime config). */
const ALLOWED_PREFIXES: ReadonlyArray<string> = ["CHROME", "PLAYWRIGHT"];

export function buildJoinerEnv(
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;

    const isAllowed =
      ALLOWED_KEYS.includes(key) ||
      ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));

    if (isAllowed) {
      env[key] = value;
    }
  }

  return env;
}
