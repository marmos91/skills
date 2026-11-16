const SEV = ["must", "should", "nit", "pre-existing"];
const str = (v) => typeof v === "string" && v.length > 0;
// digits only: the line names question ids (1e21 or -3 would not)
const line = (v) => Number.isSafeInteger(v) && v > 0;

function finding(f, p, errs) {
  if (!f || typeof f !== "object") return errs.push(`${p}: not an object`);
  if (!str(f.lens)) errs.push(`${p}.lens: required`);
  if (!SEV.includes(f.severity)) errs.push(`${p}.severity: must be ${SEV.join("|")}`);
  if (!str(f.file)) errs.push(`${p}.file: required`);
  if (!line(f.line)) errs.push(`${p}.line: must be a positive integer`);
  if (!str(f.title)) errs.push(`${p}.title: required`);
  if (!str(f.case)) errs.push(`${p}.case: required, non-empty`);
  if (typeof f.fix !== "string") errs.push(`${p}.fix: must be a string`);
}

const list = (v, p, errs, each) => {
  if (!Array.isArray(v)) return errs.push(`${p}: must be an array`);
  v.forEach((x, i) => each(x, `${p}[${i}]`, errs));
};

const stages = {
  round1(v, errs) {
    if (!v || typeof v !== "object") return errs.push("value: not an object");
    list(v.findings, "findings", errs, finding);
    if (v.earlier !== undefined && !Array.isArray(v.earlier)) errs.push("earlier: must be an array");
    if (v.no_tracking !== undefined && typeof v.no_tracking !== "boolean") errs.push("no_tracking: must be a boolean");
    // A seat that could not review says so: that is a failed child, never "no findings".
    if (v.error != null && v.error !== "") errs.push(`error: the seat could not review: ${String(typeof v.error === "string" ? v.error : JSON.stringify(v.error)).slice(0, 200)}`);
  },
  vote(v, errs) {
    list(v, "vote", errs, (x, p) => {
      if (!str(x?.id)) errs.push(`${p}.id: required`);
      if (!["keep", "drop"].includes(x?.vote)) errs.push(`${p}.vote: must be keep|drop`);
      if (typeof x?.counter_case !== "string") errs.push(`${p}.counter_case: must be a string`);
    });
  },
  merge(v, errs) {
    const ids = new Set(); // votes and proof join on the id
    list(v, "merge", errs, (x, p) => {
      // the id names files (decide/<id>-<fp>.json): judge output, so no path characters
      if (str(x?.id) && !/^[A-Za-z0-9_-]{1,64}$/.test(x.id)) errs.push(`${p}.id: letters, digits, _ and - only`);
      if (str(x?.id) && ids.has(x.id)) errs.push(`${p}.id: duplicate ${x.id}`);
      ids.add(x?.id);
      for (const k of ["id", "lens", "file", "title"]) if (!str(x?.[k])) errs.push(`${p}.${k}: required`);
      if (!SEV.includes(x?.severity)) errs.push(`${p}.severity: must be ${SEV.join("|")}`);
      if (!line(x?.line)) errs.push(`${p}.line: must be a positive integer`);
      if (!Array.isArray(x?.found)) errs.push(`${p}.found: must be an array`);
      if (x?.reverses !== undefined && !str(x.reverses)) errs.push(`${p}.reverses: must be a non-empty string`);
      if (x?.members !== undefined && !(Array.isArray(x.members) && x.members.every(str))) errs.push(`${p}.members: must be an array of finding ids`);
    });
  },
  compose(v, errs) {
    // body may be "" when the verdict carries the review.
    if (!str(v?.body) && !(typeof v?.body === "string" && str(v?.verdict))) errs.push("body: required");
    if (!str(v?.verdict)) errs.push("verdict: required");
    if (v?.praise !== undefined && typeof v.praise !== "string") errs.push("praise: must be a string");
    if (v?.answers !== undefined && !(Array.isArray(v.answers) && v.answers.every((x) => typeof x === "string"))) errs.push("answers: must be an array of strings");
    if (v?.index !== undefined) list(v.index, "index", errs, (g, p) => {
      if (typeof g?.theme !== "string") errs.push(`${p}.theme: must be a string`);
      list(g?.items, `${p}.items`, errs, (x, q) => { if (!str(x?.id) || typeof x?.text !== "string") errs.push(`${q}: needs id and text`); });
    });
    for (const k of ["corrections", "confirmed"]) if (v?.[k] !== undefined) list(v[k], k, errs, (x, p) => { if (!str(x?.thread_id) || !str(x?.text)) errs.push(`${p}: needs thread_id and text`); });
    list(v?.comments, "comments", errs, (x, p) => {
      if (!str(x?.id)) errs.push(`${p}.id: required`);
      if (!str(x?.body)) errs.push(`${p}.body: required`);
      if (x?.also !== undefined && !(Array.isArray(x.also) && x.also.every(str))) errs.push(`${p}.also: must be an array of finding ids`);
    });
    // the folded hygiene check (prompts.mjs composePrompt): the shape of the hygiene child's findings
    if (v?.hygiene !== undefined) stages.hygiene({ findings: v.hygiene }, errs);
  },
  hygiene(v, errs) {
    if (!v || typeof v !== "object") return errs.push("value: not an object");
    list(v.findings, "findings", errs, (f, p) => {
      if (!f || typeof f !== "object") return errs.push(`${p}: not an object`);
      if (f.lens !== "hygiene") errs.push(`${p}.lens: must be hygiene`);
      if (!["should", "nit"].includes(f.severity)) errs.push(`${p}.severity: must be should|nit`);
      if (!str(f.title)) errs.push(`${p}.title: required`);
      if (!str(f.case)) errs.push(`${p}.case: required, non-empty`);
      if (typeof f.fix !== "string") errs.push(`${p}.fix: must be a string`);
    });
  },
  reply(v, errs) {
    if (!["accept", "push_back", "ask"].includes(v?.position)) errs.push("position: must be accept|push_back|ask");
    if (!str(v?.body)) errs.push("body: required");
  },
};

export function validate(stage, value) {
  if (!stages[stage]) return [`unknown stage ${stage}`];
  const errs = [];
  stages[stage](value, errs);
  return errs;
}
