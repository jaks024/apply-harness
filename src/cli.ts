import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser } from "./browser.js";
import { config } from "./config.js";
import { parseQueue, runQueue, type QueueItem } from "./orchestrator.js";
import { readJsonl, type LedgerRecord } from "./store.js";
import { addJobs, loadJobs } from "./tracker.js";

const [cmd, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  switch (cmd) {
    case "apply": {
      const urls = args.filter((a, i) => /^https?:\/\//.test(a) && args[i - 1] !== "--queue");
      const queueFile = flag("queue") ?? (urls.length ? undefined : config.paths.queue);
      let items: QueueItem[] = urls.map((url) => ({ url }));
      if (queueFile) {
        if (!existsSync(queueFile)) throw new Error(`No URLs given and ${queueFile} does not exist. Put one URL per line (optionally "url | company | role").`);
        items = parseQueue(readFileSync(queueFile, "utf8"));
      }
      if (!items.length) throw new Error("Queue is empty.");
      const c = flag("concurrency");
      await runQueue(items, { concurrency: c ? Number(c) : undefined });
      break;
    }
    case "add-job": {
      // npm run add-job -- <url> [--company X] [--role Y] [--location Z], or --file with "url | company | role" lines.
      const file = flag("file");
      const items = file
        ? parseQueue(readFileSync(file, "utf8"))
        : args.filter((a) => /^https?:\/\//.test(a)).map((url) => ({ url, company: flag("company"), role: flag("role"), location: flag("location") }));
      if (!items.length) throw new Error("Give a posting URL (npm run add-job -- <url> --company X --role Y) or --file urls.txt");
      const added = addJobs(items.map((i) => ({ ...i, source: "cli" })));
      console.log(`Added ${added} job(s) to ${config.paths.tracker}${added < items.length ? ` (${items.length - added} already tracked)` : ""}.`);
      break;
    }
    case "status": {
      const tracked: Record<string, number> = {};
      for (const j of loadJobs()) tracked[j.status] = (tracked[j.status] ?? 0) + 1;
      console.log("Job tracker:", tracked);
      const ledger = readJsonl<LedgerRecord>(config.paths.ledger);
      const byStatus: Record<string, number> = {};
      const latest = new Map<string, LedgerRecord>();
      for (const r of ledger) { const p = latest.get(r.job_key); if (p?.status === "submitted" && r.status !== "submitted") continue; latest.set(r.job_key, r); }
      for (const r of latest.values()) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      console.log(`Ledger: ${latest.size} jobs`, byStatus);
      const latestRun = join(config.paths.runs, "latest.txt");
      if (existsSync(latestRun)) {
        const id = readFileSync(latestRun, "utf8").trim();
        const statePath = join(config.paths.runs, id, "state.json");
        if (existsSync(statePath)) {
          console.log(`\nRun ${id}:`);
          for (const j of JSON.parse(readFileSync(statePath, "utf8"))) console.log(`  ${j.state.padEnd(10)} ${(j.company ?? "?").slice(0, 28).padEnd(28)} ${(j.role ?? "").slice(0, 40).padEnd(40)} ${j.note ?? ""}`);
        }
      }
      break;
    }
    case "chrome": {
      // Opens the harness Chrome profile for manual use (sign in to Gmail, check a tab). Close the window to exit.
      const ctx = await launchBrowser();
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(args[0] ?? "about:blank").catch(() => {});
      await new Promise<void>((r) => ctx.on("close", () => r()));
      break;
    }
    case "check-stealth": {
      const ctx = await launchBrowser();
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("https://bot.sannysoft.com", { waitUntil: "networkidle" });
      const res = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""));
        const failed = Array.from(document.querySelectorAll("td.failed, td[class*=failed]")).map((td) => (td.parentElement?.querySelector("td")?.textContent ?? "").trim());
        return { webdriver: navigator.webdriver, userAgent: navigator.userAgent, plugins: navigator.plugins.length, failed, rows: rows.length };
      });
      console.log(JSON.stringify(res, null, 2));
      await page.screenshot({ path: join(config.paths.runs, "stealth-check.png"), fullPage: true });
      await ctx.close();
      break;
    }
    default:
      console.log(`Usage:
  npm run apply -- <url> [url...]          apply to these postings
  npm run apply                            apply to every URL in data/queue.txt
  npm run apply -- --queue file.txt --concurrency 3
  npm run add-job -- <url> [--company X] [--role Y]   add a posting to the job tracker
  npm run add-job -- --file urls.txt       add every "url | company | role" line
  npm run status                           tracker and ledger counts, and the latest run
  npm run chrome -- [url]                  open the harness Chrome profile by hand
  npm run check:stealth                    bot.sannysoft.com check
Set VERBOSE=1 to stream every field decision to the terminal.`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
