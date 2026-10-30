import type { Adapter } from "./types.js";
import { ashby, generic, greenhouse, lever, oracle } from "./simple.js";
import { workday } from "./workday.js";

const BY_PLATFORM: Record<string, Adapter> = { greenhouse, lever, ashby, workday, oracle };

export function adapterFor(platform: string): Adapter {
  return BY_PLATFORM[platform] ?? generic;
}
