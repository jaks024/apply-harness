import { noSponsorship } from "../src/engine-rules.js";
const cases: [string, boolean][] = [
  ["I acknowledge that this role is not eligible for visa sponsorship.", true],
  ["Please note: we are unable to provide visa sponsorship for this position.", true],
  ["The company does not sponsor work visas.", true],
  ["Candidates must be authorized to work in the United States without the need for current or future sponsorship.", true],
  ["Sponsorship is not available for this role.", true],
  ["We will not provide sponsorship now or in the future.", true],
  ["Will you now or in the future require visa sponsorship to continue working in the US?", false],
  ["Are you authorized to work in the U.S. without the need for employer sponsorship?", false],
  ["Do you require sponsorship?", false],
  ["We offer visa sponsorship for qualified candidates.", false],
  ["Our company provides H-1B sponsorship.", false],
];
let ok = 0;
for (const [t, want] of cases) { const got = !!noSponsorship(t); ok += +(got === want); console.log(got === want ? "PASS" : "FAIL", want ? "stop" : "go  ", "|", t.slice(0, 90)); }
console.log(`${ok}/${cases.length}`);
