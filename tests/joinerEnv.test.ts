import { describe, it, expect } from "vitest";
import { buildJoinerEnv } from "../src/meet-bot/joinerEnv.js";

describe("buildJoinerEnv", () => {
  it("includes safe runtime vars when present in the input env", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/sentinel",
    };
    const result = buildJoinerEnv(input);
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/home/sentinel");
  });

  it("excludes all application secrets", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      METABASE_PASSWORD: "metabase-secret",
      GITHUB_TOKEN: "ghp-secret",
      NOTION_API_KEY: "notion-secret",
      GOOGLE_REFRESH_TOKEN: "google-refresh-secret",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
    };
    const result = buildJoinerEnv(input);

    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_APP_TOKEN).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.METABASE_PASSWORD).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.NOTION_API_KEY).toBeUndefined();
    expect(result.GOOGLE_REFRESH_TOKEN).toBeUndefined();
    expect(result.GOOGLE_CLIENT_SECRET).toBeUndefined();

    // None of the secret values should leak under any key.
    const secretValues = Object.values(input).filter((v) =>
      v?.includes("secret")
    );
    expect(secretValues.length).toBeGreaterThan(0);
    for (const value of Object.values(result)) {
      expect(secretValues).not.toContain(value);
    }
  });

  it("passes through PLAYWRIGHT_* and CHROME_* keys", () => {
    const input: NodeJS.ProcessEnv = {
      PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
      CHROME_PATH: "/usr/bin/google-chrome",
    };
    const result = buildJoinerEnv(input);
    expect(result.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/ms-playwright");
    expect(result.CHROME_PATH).toBe("/usr/bin/google-chrome");
  });

  it("omits allowlisted keys that are absent from the input", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
    };
    const result = buildJoinerEnv(input);
    expect("HOME" in result).toBe(false);
    expect("TMPDIR" in result).toBe(false);
    expect("LANG" in result).toBe(false);
  });

  it("returns a new object and does not mutate or alias parentEnv", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SLACK_BOT_TOKEN: "xoxb-secret",
    };
    const result = buildJoinerEnv(input);
    expect(result).not.toBe(input);

    // Mutating the result must not affect the input.
    result.PATH = "/changed";
    expect(input.PATH).toBe("/usr/bin");

    // The input is left untouched.
    expect(input.SLACK_BOT_TOKEN).toBe("xoxb-secret");
  });
});
