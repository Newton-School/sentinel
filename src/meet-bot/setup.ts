#!/usr/bin/env node

/**
 * One-time setup script to create a persistent Chromium profile with the
 * Sentinel Google account signed in.
 *
 * Usage:
 *   npx tsx src/meet-bot/setup.ts
 *
 * This opens a visible Chromium window. Sign in with sentinel@newtonschool.co,
 * then close the browser. The profile is saved to ./data/sentinel-chrome-profile
 * and reused by every future bot run.
 *
 * Re-run this script if the session expires (you'll see the bot get stuck at
 * the login page).
 */

import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const PROFILE_DIR = join(process.cwd(), "data", "sentinel-chrome-profile");

async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });

  console.log("");
  console.log("=== Sentinel Meet Bot — Profile Setup ===");
  console.log("");
  console.log("Opening Chromium. Please:");
  console.log("  1. Go to https://accounts.google.com");
  console.log("  2. Sign in with sentinel@newtonschool.co");
  console.log("  3. Complete any 2FA challenges");
  console.log("  4. Verify you can open https://meet.google.com (no login prompt)");
  console.log("  5. Close the browser window when done");
  console.log("");
  console.log(`Profile will be saved to: ${PROFILE_DIR}`);
  console.log("");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await context.newPage();
  await page.goto("https://accounts.google.com");

  // Wait for the user to close the browser
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  console.log("");
  console.log("=== Setup complete ===");
  console.log(`Profile saved to: ${PROFILE_DIR}`);
  console.log("You can now run the bot with: npx tsx src/meet-bot/joiner.ts <meet-url>");
  console.log("");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
