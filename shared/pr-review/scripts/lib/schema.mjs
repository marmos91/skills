const SEV = ["must", "should", "nit"];
const str = (v) => typeof v === "string" && v.length > 0;

function finding(f, p, errs) {
  if (!f || typeof f !== "object") return errs.push(`${p}: not an object`);
  if (!str(f.lens)) errs.push(`${p}.lens: required`);
  if (!SEV.includes(f.severity)) errs.push(`${p}.severity: must be ${SEV.join("|")}`);
  if (!str(f.file)) errs.push(`${p}.file: required`);
  if (typeof f.line !== "number") errs.push(`${p}.line: must be a number`);
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
    if (v.error !== undefined && v.error !== "") errs.push(`error: the seat could not review: ${String(typeof v.error === "string" ? v.error : JSON.stringify(v.error)).slice(0, 200)}`);
  },
  vote(v, errs) {
    list(v, "vote", errs, (x, p) => {
      if (!str(x?.id)) errs.push(`${p}.id: required`);
      if (!["keep", "drop"].includes(x?.vote)) errs.push(`${p}.vote: must be keep|drop`);
      if (typeof x?.counter_case !== "string") errs.push(`${p}.counter_case: must be a string`);
    });
  },
  merge(v, errs) {
    list(v, "merge", errs, (x, p) => {
      for (const k of ["id", "lens", "file", "title"]) if (!str(x?.[k])) errs.push(`${p}.${k}: required`);
      if (!SEV.includes(x?.severity)) errs.push(`${p}.severity: must be ${SEV.join("|")}`);
      if (typeof x?.line !== "number") errs.push(`${p}.line: must be a number`);
      if (!Array.isArray(x?.found)) errs.push(`${p}.found: must be an array`);
      if (x?.reverses !== undefined && !str(x.reverses)) errs.push(`${p}.reverses: must be a non-empty string`);
    });
  },
  compose(v, errs) {
    if (!str(v?.body)) errs.push("body: required");
    list(v?.comments, "comments", errs, (x, p) => {
      if (!str(x?.id)) errs.push(`${p}.id: required`);
      if (!str(x?.body)) errs.push(`${p}.body: required`);
    });
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
