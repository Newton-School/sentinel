#!/usr/bin/env node

/**
 * Google Meet joiner — launches headless Chromium using a pre-configured profile
 * (run src/meet-bot/setup.ts once first to sign in) and joins a Meet call as
 * the Sentinel account.
 *
 * Usage:
 *   npx tsx src/meet-bot/joiner.ts <meet-url>
 *   npx tsx src/meet-bot/joiner.ts <meet-url> --duration 1800   # stay for 30 min
 *   npx tsx src/meet-bot/joiner.ts <meet-url> --headed          # show browser
 *
 * The bot joins muted with camera off and stays in the call until either
 * (a) the meeting ends, (b) the duration limit is reached, or (c) it's kicked.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { isValidMeetUrl, extractMeetingCode } from "./meetUrl.js";

const PROFILE_DIR = join(process.cwd(), "data", "sentinel-chrome-profile");
const DEFAULT_DURATION_SEC = 2 * 60 * 60; // 2 hours max

interface JoinOptions {
  meetUrl: string;
  maxDurationSec: number;
  headed: boolean;
}

function parseArgs(argv: string[]): JoinOptions {
  const meetUrl = argv[0];
  if (!meetUrl) {
    console.error("Usage: npx tsx src/meet-bot/joiner.ts <meet-url> [--duration <sec>] [--headed]");
    process.exit(1);
  }
  if (!isValidMeetUrl(meetUrl)) {
    console.error(`Invalid Meet URL: ${meetUrl}`);
    process.exit(1);
  }

  let maxDurationSec = DEFAULT_DURATION_SEC;
  const durationIdx = argv.indexOf("--duration");
  if (durationIdx !== -1 && argv[durationIdx + 1]) {
    maxDurationSec = parseInt(argv[durationIdx + 1], 10);
  }

  const headed = argv.includes("--headed");

  return { meetUrl, maxDurationSec, headed };
}

async function joinMeeting(opts: JoinOptions): Promise<void> {
  const code = extractMeetingCode(opts.meetUrl);
  console.log(`[meet-bot] Joining meeting: ${code}`);
  console.log(`[meet-bot] Profile: ${PROFILE_DIR}`);
  console.log(`[meet-bot] Max duration: ${opts.maxDurationSec}s`);
  console.log(`[meet-bot] Headed: ${opts.headed}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !opts.headed,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream", // auto-grant mic/camera permissions
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
    permissions: ["microphone", "camera"],
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(opts.meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log("[meet-bot] Page loaded");

    // Wait for the Meet UI to render
    await page.waitForTimeout(3000);

    // Try to turn off mic and camera before joining (find buttons by aria-label)
    await turnOffMediaDevices(page);

    // Click "Join now" or "Ask to join"
    const joined = await clickJoinButton(page);
    if (!joined) {
      console.error("[meet-bot] Failed to find join button");
      await context.close();
      process.exit(1);
    }

    console.log("[meet-bot] Joined the meeting");

    // Stay in the call until end/timeout/kicked
    await waitForMeetingEnd(page, opts.maxDurationSec);

    console.log("[meet-bot] Meeting ended or timeout reached");
  } catch (err) {
    console.error("[meet-bot] Error:", err);
  } finally {
    await context.close();
  }
}

async function turnOffMediaDevices(page: Page): Promise<void> {
  try {
    // Microphone toggle — aria-label is "Turn off microphone" when on
    const micButton = page.locator('[aria-label*="microphone"i]').first();
    if (await micButton.isVisible({ timeout: 5000 })) {
      const label = await micButton.getAttribute("aria-label");
      if (label?.toLowerCase().includes("turn off")) {
        await micButton.click();
        console.log("[meet-bot] Mic turned off");
      }
    }
  } catch {
    // Ignore — mic may already be off
  }

  try {
    const camButton = page.locator('[aria-label*="camera"i]').first();
    if (await camButton.isVisible({ timeout: 2000 })) {
      const label = await camButton.getAttribute("aria-label");
      if (label?.toLowerCase().includes("turn off")) {
        await camButton.click();
        console.log("[meet-bot] Camera turned off");
      }
    }
  } catch {
    // Ignore
  }
}

async function clickJoinButton(page: Page): Promise<boolean> {
  const candidateTexts = ["Join now", "Ask to join"];

  for (let attempt = 0; attempt < 15; attempt++) {
    for (const text of candidateTexts) {
      const button = page.getByRole("button", { name: new RegExp(text, "i") });
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        await button.click();
        console.log(`[meet-bot] Clicked "${text}"`);
        return true;
      }
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function waitForMeetingEnd(page: Page, maxDurationSec: number): Promise<void> {
  const deadline = Date.now() + maxDurationSec * 1000;
  const checkIntervalMs = 10_000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(checkIntervalMs);

    // Check if we've been kicked or the meeting ended
    const endedIndicators = [
      'text="You left the meeting"',
      'text="The meeting has ended"',
      'text="No one else is here"', // solo for too long could be an indicator
      'button:has-text("Return to home screen")',
      'button:has-text("Rejoin")',
    ];

    for (const selector of endedIndicators) {
      const found = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (found) {
        console.log(`[meet-bot] Detected meeting end via: ${selector}`);
        return;
      }
    }
  }

  console.log("[meet-bot] Max duration reached");
}

const opts = parseArgs(process.argv.slice(2));
joinMeeting(opts).catch((err) => {
  console.error("[meet-bot] Fatal:", err);
  process.exit(1);
});
