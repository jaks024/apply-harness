/** Set from the answer bank at startup (resolve.ts). */
export const matchPrefs = { preferVisaYes: false };

export function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+]+/g, " ").trim();
}

const SYN: Record<string, string> = { woman: "female", women: "female", man: "male", men: "male", usa: "united states", us: "united states", "united states of america": "united states" };

const STATES: Record<string, string> = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming" };

function canon(s: string): string {
  let n = norm(s);
  for (const [k, v] of Object.entries(SYN)) if (n === k) n = v;
  // Degrees: "Master of Science", "M.S.", "Master's Degree", "Masters" → "master"; same for bachelor
  n = n.replace(/\bmaster s\b|\bmasters\b/g, "master").replace(/\bbachelor s\b|\bbachelors\b/g, "bachelor");
  n = n.replace(/\bmaster of (science|arts|business administration|engineering)\b|^m ?s$|^msc$|^ma$/g, "master")
    .replace(/\bbachelor s\b|\bbachelors\b|\bbachelor of (science|arts)\b|^b ?s$|^ba$/g, "bachelor")
    .replace(/\bdegree\b/g, "").replace(/\s+/g, " ").trim();
  // "San Diego, CA" ≈ "San Diego, California": expand two-letter state codes after a comma
  n = n.replace(/ ([a-z]{2})$/, (m, st) => (STATES[st] && s.includes(",") ? ` ${STATES[st]}` : m));
  return n;
}

// "I am not…" starts with "I am": a negation is never a yes.
function isYes(s: string) { return !isNo(s) && /^(yes|y|true|i am|i do|i have|i will|i agree|i consent)\b/.test(norm(s)); }
function isNo(s: string) { return /^(no|n|false|i am not|i do not|i dont|i have not|i havent|i will not|none|not a)\b/.test(norm(s)); }

/** Picks the option that best matches the intended answer, or null if nothing is a confident match. */
export function bestOption(answer: string, options: string[]): string | null {
  if (!options.length) return null;
  // Word-for-word first (brackets dropped): "Master of Science" = "Master of Science (MS)", before canon() folds
  // every master's degree into "master" and "Master of Engineering (ME)" becomes just as good.
  const plain = (x: string) => norm(x.replace(/\([^)]*\)/g, " ").replace(/\+\d+/g, " ")).replace(/\b(master|bachelor)s? of\b/g, "$1 of");
  const literal = options.filter((o) => plain(o) === plain(answer));
  if (literal.length) return literal.sort((x, y) => x.length - y.length)[0];
  // A specific degree ("Master of Science") never matches a different specific one ("Master of Business
  // Administration (M.B.A.)", "Master of Engineering"); generic ones ("Master's Degree") and the same field still do.
  const DEG = /^(master|bachelor)s? of (\w+)/;
  // Bare abbreviations name a specific degree too: "MA" is a Master of Arts, not just "a master's".
  const ABBR: Record<string, string> = { ms: "master of science", msc: "master of science", "m s": "master of science", ma: "master of arts", "m a": "master of arts", meng: "master of engineering", mba: "master of business administration", "m b a": "master of business administration", bs: "bachelor of science", bsc: "bachelor of science", "b s": "bachelor of science", ba: "bachelor of arts", "b a": "bachelor of arts", bba: "bachelor of business administration" };
  const spelled = (x: string) => { const n = norm(x.replace(/\([^)]*\)/g, " ")); return ABBR[n] ?? norm(x).replace(/ s of /, " of "); };
  const want = spelled(answer).match(DEG);
  if (want) options = options.filter((o) => { const m = spelled(o).match(DEG); return !m || m[1] !== want[1] || m[2] === want[2]; });
  if (want && /^(master|bachelor) of business administration/.test(norm(answer)) === false) options = options.filter((o) => !/^m ?b ?a$|^mba\b/.test(norm(o.replace(/\([^)]*\)/g, ""))));
  if (!options.length) return null;
  // "Master's Degree - completed" vs "Master's Degree - in progress or not completed": the status decides.
  const statusOf = (s: string) => /in progress|not completed|pursuing|currently enrolled|expected|incomplete/i.test(s) ? "progress" : /\bcompleted\b|\bgraduated\b/i.test(s) ? "done" : null;
  if (options.some((o) => statusOf(o) === "progress") && options.some((o) => statusOf(o) === "done")) {
    const want = statusOf(answer) ?? "done";
    options = options.filter((o) => statusOf(o) !== (want === "progress" ? "done" : "progress"));
    answer = answer.replace(/\(?\s*(in progress|expected|pursuing|completed)\s*\)?/gi, " ").trim();
  }
  const a = canon(answer);
  const exact = options.find((o) => canon(o) === a);
  if (exact) return exact;
  // Same thing once codes and notes in brackets are dropped: "United States" = "United States of America (+1)",
  // never "United States Minor Outlying Islands (+1)" just because it happens to come first.
  const bare = (x: string) => canon(x.replace(/\([^)]*\)/g, " ").replace(/\+\d+/g, " "));
  const ab = bare(answer);
  const exactBare = options.filter((o) => bare(o) === ab);
  if (exactBare.length) return exactBare.sort((x, y) => x.length - y.length)[0];
  // "Decline to answer" ≈ "I don't wish to answer" ≈ "Prefer not to say"
  if (looksDeclined(answer)) { const d = options.filter(looksDeclined); if (d.length >= 1) return d.sort((x, y) => x.length - y.length)[0]; }
  // Yes/No answers map onto options that start with yes/no ("Yes, I am authorized…")
  if (a === "yes" || a === "no") {
    const want = a === "yes" ? isYes : isNo;
    const hits = options.filter((o) => want(o) && !looksDeclined(o));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1 && a === "yes" && matchPrefs.preferVisaYes) {
      // Several kinds of "yes" to a work-authorization question, and the candidate is on a visa that needs
      // sponsorship: "with restrictions"/visa wins, and "citizen"/"permanent resident"/"without restrictions" never does.
      const visa = hits.filter((o) => /with restrictions|visa|sponsor|non-?immigrant|\bf-?1\b|\bopt\b|\bcpt\b|\bead\b/i.test(o) && !/without (any )?(restriction|sponsor)/i.test(o));
      const safe = hits.filter((o) => !/citizen|permanent resident|green card|without (any )?restriction/i.test(o));
      const pool = visa.length ? visa : safe.length ? safe : hits;
      return pool.sort((x, y) => x.length - y.length)[0];
    }
    if (hits.length > 1) return hits.sort((x, y) => x.length - y.length)[0];
  }
  // "I am not a protected veteran" must never land on "I Am a Protected Veteran": a negated answer only matches
  // negated options (declines aside) when there are any.
  const negated = (x: string) => /\bnot\b|\bno\b|\bnon\b|n t\b|\bnever\b/.test(norm(x));
  if (negated(answer) && options.some((o) => negated(o) && !looksDeclined(o))) options = options.filter((o) => negated(o) && !looksDeclined(o));
  // Whole-word comparisons: "east asian" must not match inside "southeast asian".
  const starts = options.filter((o) => { const c = canon(o); return c.startsWith(a + " ") || a.startsWith(c + " "); });
  if (starts.length === 1) return starts[0];
  const contains = options.filter((o) => ` ${canon(o)} `.includes(` ${a} `));
  if (contains.length === 1) return contains[0];
  // token overlap; generic words ("university", "degree", "the") alone never make a match
  const GENERIC = new Set(["university", "college", "school", "institute", "of", "the", "and", "in", "at", "for", "inc", "llc", "company", "i", "am", "a", "an"]);
  const at = new Set(a.split(" ").filter((t) => t.length > 1));
  let best: string | null = null, score = 0, coverageOfBest = 0;
  for (const o of options) {
    const ot = new Set(canon(o).split(" ").filter((t) => t.length > 1));
    if (!ot.size) continue;
    const shared = [...at].filter((t) => ot.has(t));
    if (!shared.some((t) => !GENERIC.has(t))) continue;
    const coverage = shared.length / at.size; // how much of the intended answer the option contains
    const precision = shared.length / ot.size; // how little else the option says
    const s = coverage * 0.7 + precision * 0.3;
    if (s > score) { score = s; best = o; coverageOfBest = coverage; }
  }
  // "United States" vs "Micronesia, Federated States of" shares one word in three: not a match (score 0.45).
  // Half the answer's words and nothing else is weak: "Data Science" must not become "Data Communications"
  // (0.5), though "Science" alone is fine (0.65).
  if (best && coverageOfBest >= 0.5 && score > 0.55) return best;
  // negation-aware fallbacks for long EEO phrasings
  if (isNo(answer)) { const hits = options.filter((o) => isNo(o) && !looksDeclined(o)); if (hits.length === 1) return hits[0]; }
  if (isYes(answer)) { const hits = options.filter((o) => isYes(o) && !looksDeclined(o)); if (hits.length === 1) return hits[0]; }
  // A qualified answer can fall back to its core word when nothing matched at all ("South Asian" → "Asian (Not Hispanic…)").
  const words = answer.trim().split(/\s+/);
  if (words.length === 2 && !/^(yes|no)$/i.test(words[0])) {
    const core = words[1];
    const hits = options.filter((o) => ` ${canon(o)} `.includes(` ${canon(core)} `));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export function looksDeclined(s: string) {
  return /decline|prefer not|do not wish|dont wish|choose not|not to (answer|disclose|self)|wish not to/i.test(s.replace(/[’']/g, ""));
}

/**
 * Place suggestions ("New York, NY" against "Upstate New York City, New York, United States", "New York, USA",
 * "New York, NY, USA"): the first segment must be the city itself, and one later segment should be the state.
 * Returns null when the value isn't a "City, ST" place, so callers fall back to bestOption.
 */
export function bestPlace(value: string, options: string[]): string | null {
  const [city, region] = value.split(",").map((x) => x.trim().toLowerCase());
  if (!city || !region || !options.length) return null;
  const regions = [region, STATES[region] ?? ""].filter(Boolean);
  const scored = options.map((o) => {
    const segs = o.toLowerCase().split(",").map((x) => x.trim().replace(/\s+/g, " "));
    let sc = segs[0] === city ? 2 : segs[0] === `${city} city` ? 1.5 : 0;
    if (segs.slice(1).some((x) => regions.includes(x))) sc += 1;
    return { o, sc };
  }).filter((x) => x.sc >= 1.5);
  scored.sort((a, b) => b.sc - a.sc);
  return scored[0]?.o ?? null;
}

/**
 * True when an option is the answer itself, not merely the best guess: stops a list scan early. Strict on purpose:
 * only word-for-word (brackets and dial codes dropped) or a listed synonym ("United States" = "United States of
 * America"). canon() would call every master's degree "master", so it is not used here.
 */
export function isExactOption(answer: string, option: string): boolean {
  const plain = (x: string) => norm(x.replace(/\([^)]*\)/g, " ").replace(/\+\d+/g, " ")).replace(/\b(master|bachelor)s? of\b/g, "$1 of");
  const syn = (x: string) => SYN[plain(x)] ?? plain(x);
  return syn(option) === syn(answer);
}

/** True when this option can't be the answer whatever else is listed (a different specific degree, e.g. an MBA for an MS). */
export function ruledOut(answer: string, option: string): boolean {
  return bestOption(answer, [option]) === null && /^(master|bachelor)s? of /.test(norm(answer).replace(/ s of /, " of ")) && /\b(master|bachelor|mba|m b a)\b/.test(norm(option));
}
