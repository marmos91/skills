// Vote tally for a council finding (spec 6.6 / 9.1): each independent find is one keep.
export const votersFor = ({ found, seats }) => seats.filter((s) => !found.includes(s));

export function tally({ cluster, votes }) {
  const voters = new Set(votersFor(cluster));
  const valid = votes.filter((v) => voters.has(v.seat));
  const keeps = cluster.found.length + valid.filter((v) => v.vote === "keep").length;
  // a drop without a counter-case abstains
  const drops = valid.filter((v) => v.vote === "drop" && v.counter_case?.trim()).length;
  const evidence = valid.some((v) => v.vote === "keep" && v.evidence_run);
  if (drops * 2 > keeps + drops && !evidence) return "rejected";
  if (drops > 0) return "split";
  return keeps >= 2 ? "agreed" : "split";
}
