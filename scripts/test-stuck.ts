// Simulated hangs: (A) a click starts a navigation that never finishes, (B) a Workday-style loading overlay that
// never clears, (C) a normal page. A and B must be reopened in a fresh tab; C must be left alone.
import { createServer } from "node:http";
import { launchBrowser } from "../src/browser.js";
import { ensureLoaded } from "../src/engine.js";
import type { JobCtx } from "../src/adapters/types.js";

const FORM = (btn: string) => `<!doctype html><title>Create Account</title><h1>Create Account</h1>
<label for=e>Email</label><input id=e><label for=p>Password</label><input id=p type=password>
<button id=go type=button onclick="${btn}">Create Account</button><button type=button>Sign In</button>`;
const srv = createServer((req, res) => {
  if (req.url === "/hang") return; // never answers: the tab spins forever
  res.writeHead(200, { "Content-Type": "text/html" });
  if (req.url === "/a") return res.end(FORM("location.href='/hang'"));
  if (req.url === "/b") return res.end(FORM("document.body.insertAdjacentHTML('beforeend','<div data-automation-id=loadingSpinner style=position:fixed;inset:0;background:#fff8>Loading…</div>')"));
  res.end(FORM("void 0"));
}).listen(8767);

const b = await launchBrowser("data/debug/test-profile");
let ok = true;
for (const [name, path, expectReopen] of [["A hung navigation", "/a", true], ["B stuck spinner", "/b", true], ["C normal page", "/c", false]] as const) {
  let page = await b.newPage();
  await page.goto(`http://127.0.0.1:8767${path}`);
  let swapped = 0;
  const ctx = { url: `http://127.0.0.1:8767${path}`, log: (s: string) => console.log(`   ${s}`), replacePage: () => { swapped++; } } as unknown as JobCtx;
  page = await ensureLoaded(page, ctx, 6_000); // records the good URL
  const old = page;
  await old.click("#go", { noWaitAfter: true }).catch(() => {});
  const t = Date.now();
  page = await ensureLoaded(page, ctx, 6_000);
  const reopened = page !== old;
  const fieldsOk = await page.locator("#e").isVisible().catch(() => false);
  const pass = reopened === expectReopen && fieldsOk && (!reopened || old.isClosed());
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: reopened=${reopened} oldClosed=${old.isClosed()} formVisible=${fieldsOk} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  await page.close().catch(() => {});
}
await b.close(); srv.close();
process.exit(ok ? 0 : 1);
