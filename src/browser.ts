import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext } from "patchright";
import { config } from "./config.js";

/**
 * Real Chrome via Patchright with a dedicated persistent profile.
 * Patchright removes --enable-automation, hides navigator.webdriver and never calls Runtime.enable.
 * Keep custom args minimal: anything unusual is itself a fingerprint.
 */
export async function launchBrowser(profileDir = config.chrome.profileDir): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: config.chrome.channel,
    headless: false,
    viewport: null,
    // Parallel jobs run in background tabs; keep their timers and rendering alive.
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
  // Ceilings so a hung tab fails an action instead of waiting forever (default would be no limit).
  // Clicks/fills that can't happen fail fast so the model or the rescue agent takes over sooner; page loads keep 45s.
  ctx.setDefaultTimeout(8_000);
  ctx.setDefaultNavigationTimeout(45_000);
  return ctx;
}
