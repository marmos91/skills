// Vote tally for a council finding (spec 6.6 / 9.1): each independent find is one keep.
export const votersFor = ({ found, seats }) => seats.filter((s) => !found.includes(s));

// only the first vote of each eligible seat counts
export function validVotes({ cluster, votes }) {
  const voters = new Set(votersFor(cluster));
  const seen = new Set();
  return votes.filter((v) => voters.has(v.seat) && !seen.has(v.seat) && seen.add(v.seat));
}

export function tally({ cluster, votes }) {
  const valid = validVotes({ cluster, votes });
  const keeps = new Set(cluster.found).size + valid.filter((v) => v.vote === "keep").length;
  // a drop without a counter-case abstains
  const drops = valid.filter((v) => v.vote === "drop" && typeof v.counter_case === "string" && v.counter_case.trim()).length;
  const evidence = valid.some((v) => v.vote === "keep" && v.evidence_run);
  if (drops * 2 > keeps + drops && !evidence) return "rejected";
  if (drops > 0) return "split";
  return keeps >= 2 ? "agreed" : "split";
}
