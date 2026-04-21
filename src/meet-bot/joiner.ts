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
import { existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { isValidMeetUrl, extractMeetingCode } from "./meetUrl.js";
import { decideAction, parseStayMode, type StayMode } from "./modeDispatch.js";

const PROFILE_DIR = join(process.cwd(), "data", "sentinel-chrome-profile");
const DEFAULT_DURATION_SEC = 2 * 60 * 60; // 2 hours max

interface JoinOptions {
  meetUrl: string;
  maxDurationSec: number;
  headed: boolean;
  stayMode: StayMode;
}

function parseArgs(argv: string[]): JoinOptions {
  const meetUrl = argv[0];
  if (!meetUrl) {
    console.error(
      "Usage: npx tsx src/meet-bot/joiner.ts <meet-url> [--duration <sec>] [--headed] [--stay-mode <mode>]"
    );
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

  const stayModeIdx = argv.indexOf("--stay-mode");
  const stayMode = parseStayMode(
    stayModeIdx !== -1 ? argv[stayModeIdx + 1] : undefined
  );

  return { meetUrl, maxDurationSec, headed, stayMode };
}

function cleanProfileLocks(dir: string): void {
  if (!existsSync(dir)) return;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(d, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (name === "LOCK" || name.startsWith("Singleton")) {
        try {
          unlinkSync(path);
        } catch {
          // Ignore
        }
      }
    }
  };
  walk(dir);
}

async function joinMeeting(opts: JoinOptions): Promise<void> {
  const code = extractMeetingCode(opts.meetUrl);
  console.log(`[meet-bot] Joining meeting: ${code}`);
  console.log(`[meet-bot] Profile: ${PROFILE_DIR}`);
  console.log(`[meet-bot] Max duration: ${opts.maxDurationSec}s`);
  console.log(`[meet-bot] Headed: ${opts.headed}`);
  console.log(`[meet-bot] Stay mode: ${opts.stayMode}`);

  // Clean stale lock files that can prevent Chrome from starting
  cleanProfileLocks(PROFILE_DIR);

  console.log("[meet-bot] Launching Chrome...");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: !opts.headed,
    viewport: { width: 1280, height: 800 },
    timeout: 60_000,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream", // auto-grant mic/camera permissions
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
    permissions: ["microphone", "camera"],
  });
  console.log("[meet-bot] Chrome launched");

  const existingPages = context.pages();
  console.log(`[meet-bot] Existing pages: ${existingPages.length}`);
  const page = existingPages[0] ?? (await context.newPage());
  console.log("[meet-bot] Page ready, navigating to Meet URL...");

  try {
    await page.goto(opts.meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const url = page.url();
    console.log(`[meet-bot] Page loaded. Current URL: ${url}`);

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

    // Give the Meet UI a moment to settle
    await page.waitForTimeout(5000);

    // Register participation by waiting for the Leave button to appear
    const registered = await waitForLeaveButton(page, 20_000);
    if (!registered) {
      console.warn("[meet-bot] Could not confirm participation (Leave button not seen)");
    } else {
      console.log("[meet-bot] Participation registered (Leave button visible)");
    }

    // Auto-start transcription and track whether it succeeded
    const transcriptionOn = await startTranscription(page);
    console.log(`[meet-bot] Transcription on: ${transcriptionOn}`);

    const action = decideAction(opts.stayMode, transcriptionOn);
    console.log(`[meet-bot] Decided action: ${action}`);

    if (action === "leave") {
      await leaveGracefully(page);
    } else {
      await waitForMeetingEnd(page, opts.maxDurationSec);
    }

    console.log("[meet-bot] Done");
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
  // If a "Your name" input is present (guest flow), fill it first
  try {
    const nameInput = page.getByRole("textbox", { name: /name/i }).first();
    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameInput.fill("Sentinel");
      console.log('[meet-bot] Filled guest name "Sentinel"');
      await page.waitForTimeout(500);
    }
  } catch {
    // No name input — probably signed in
  }

  const candidateTexts = ["Join now", "Ask to join"];

  for (let attempt = 0; attempt < 15; attempt++) {
    for (const text of candidateTexts) {
      const button = page.getByRole("button", { name: new RegExp(text, "i") }).first();
      if (!(await button.isVisible({ timeout: 2000 }).catch(() => false))) continue;

      // Wait for the button to be enabled
      const enabled = await button
        .isEnabled({ timeout: 10_000 })
        .catch(() => false);
      if (!enabled) {
        console.log(`[meet-bot] "${text}" button visible but disabled, waiting...`);
        continue;
      }

      await button.click();
      console.log(`[meet-bot] Clicked "${text}"`);
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function startTranscription(page: Page): Promise<boolean> {
  console.log("[meet-bot] Attempting to start transcription...");

  try {
    // If already transcribing, short-circuit
    const alreadyOn = await page
      .locator('text=/Transcribing|Transcript is on|Transcription is on/i')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (alreadyOn) {
      console.log("[meet-bot] Transcription is already on");
      return true;
    }

    // Strategy 1: Activities panel → Transcripts → Start
    const activitiesBtn = page
      .locator('[aria-label*="Activities" i], button:has-text("Activities")')
      .first();

    if (await activitiesBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await activitiesBtn.click();
      console.log("[meet-bot] Opened Activities panel");
      await page.waitForTimeout(1500);

      const transcriptsTile = page
        .getByRole("button", { name: /^Transcripts/i })
        .first();

      if (await transcriptsTile.isVisible({ timeout: 3000 }).catch(() => false)) {
        await transcriptsTile.click();
        console.log("[meet-bot] Opened Transcripts section");
        await page.waitForTimeout(1500);

        const startBtn = page
          .getByRole("button", { name: /Start transcription|Turn on transcript/i })
          .first();

        if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await startBtn.click();
          console.log("[meet-bot] Clicked Start transcription");
          await page.waitForTimeout(1500);

          const confirmBtn = page
            .getByRole("button", { name: /^Start$|Got it|Accept|Continue/i })
            .first();
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log("[meet-bot] Confirmed transcription start");
          }

          console.log("[meet-bot] Transcription started");
          return true;
        }
      }
    }

    // Strategy 2: Fallback — three-dot "More options" menu
    const moreBtn = page.locator('[aria-label*="More options" i]').first();

    if (await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await moreBtn.click();
      console.log("[meet-bot] Opened More options menu");
      await page.waitForTimeout(1000);

      const transcriptItem = page
        .getByRole("menuitem", { name: /transcript/i })
        .first();

      if (await transcriptItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await transcriptItem.click();
        console.log("[meet-bot] Clicked transcript menu item");
        await page.waitForTimeout(1500);

        const startBtn = page
          .getByRole("button", { name: /Start transcription|Start|Turn on/i })
          .first();
        if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await startBtn.click();
          console.log("[meet-bot] Transcription started (via More options)");
          return true;
        }
      }
    }

    console.warn("[meet-bot] Could not find transcription controls");
    return false;
  } catch (err) {
    console.warn("[meet-bot] Error starting transcription:", err);
    return false;
  }
}

async function waitForLeaveButton(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .locator('[aria-label*="Leave call" i], [aria-label*="Leave meeting" i]')
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

async function leaveGracefully(page: Page): Promise<void> {
  console.log("[meet-bot] Leaving the meeting...");

  try {
    const leaveBtn = page
      .locator('[aria-label*="Leave call" i], [aria-label*="Leave meeting" i]')
      .first();

    if (await leaveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await leaveBtn.click();
      console.log("[meet-bot] Clicked Leave call");

      // If Meet shows a "Leave / End for everyone" dialog, pick "Just leave"
      const justLeave = page
        .getByRole("button", { name: /Just leave the call|Just leave|Leave call/i })
        .first();
      if (await justLeave.isVisible({ timeout: 2000 }).catch(() => false)) {
        await justLeave.click();
        console.log("[meet-bot] Confirmed 'Just leave the call'");
      }

      // Wait briefly for the exit confirmation so Meet server registers the leave
      const confirmed = await page
        .locator('text=/You left the meeting/i')
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (confirmed) {
        console.log("[meet-bot] Exit confirmed by Meet server");
      } else {
        console.log("[meet-bot] Exit confirmation not seen (may still be clean)");
      }
    } else {
      console.warn("[meet-bot] Leave button not visible — forcing Chrome close");
    }
  } catch (err) {
    console.warn("[meet-bot] Error during graceful leave:", err);
  }
}

async function waitForMeetingEnd(page: Page, maxDurationSec: number): Promise<void> {
  const deadline = Date.now() + maxDurationSec * 1000;
  const checkIntervalMs = 15_000;

  // Wait a bit for the call UI to settle after "Ask to join" (admission takes time)
  await page.waitForTimeout(10_000);

  while (Date.now() < deadline) {
    await page.waitForTimeout(checkIntervalMs);

    // We're in the call if we can see the Leave call button (strong signal)
    const inCall = await page
      .locator('[aria-label*="Leave call" i], [aria-label*="Leave meeting" i]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    // Only check for end indicators once we've confirmed we were in the call
    // AND those indicators are visible without the Leave button
    if (!inCall) {
      const endedIndicators = [
        'text="You left the meeting"',
        'text="The meeting has ended"',
        'text="You\'ve been removed from the meeting"',
      ];
      for (const selector of endedIndicators) {
        const found = await page
          .locator(selector)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (found) {
          console.log(`[meet-bot] Detected meeting end via: ${selector}`);
          return;
        }
      }
    }

    console.log(`[meet-bot] Still in call (leave button visible: ${inCall})`);
  }

  console.log("[meet-bot] Max duration reached");
}

const opts = parseArgs(process.argv.slice(2));
joinMeeting(opts).catch((err) => {
  console.error("[meet-bot] Fatal:", err);
  process.exit(1);
});
