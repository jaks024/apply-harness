// CLI runner: queue the given postings in a Manager and exit once every job has ended
// (submitted, duplicate, skipped, closed or failed). The dashboard (`npm run ui`) uses the same Manager.
import { Manager, parseQueue, type QueueItem } from "./manager.js";

export { parseQueue, type QueueItem };

export async function runQueue(items: QueueItem[], opts: { concurrency?: number } = {}): Promise<void> {
  const m = new Manager({ concurrency: opts.concurrency });
  // Terminal output for a CLI run: slot-limited, and a tab waiting for review keeps its slot.
  console.log(`${items.length} job(s), ${m.concurrency} at a time. Review the ✅ READY tabs and Submit; I record each confirmation.`);
  m.add(items);
  await new Promise<void>((resolve) => {
    const check = () => { if (m.idle()) resolve(); };
    m.on("change", check);
    check();
  });
  const counts = m.snapshot().jobs.reduce<Record<string, number>>((a, j) => ((a[j.state] = (a[j.state] ?? 0) + 1), a), {});
  console.log("done:", counts);
  await m.close();
}
