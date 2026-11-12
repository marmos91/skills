/** At most n tasks at once: limiter(n)(fn) runs fn when a slot is free and gives its result. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const [fn, ok, bad] = queue.shift();
    Promise.resolve().then(fn).then(ok, bad).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((ok, bad) => { queue.push([fn, ok, bad]); next(); });
}
