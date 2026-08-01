/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * Results keep the input order. A worker that throws yields `{ ok: false, error }`
 * for that item instead of rejecting the whole batch — at discovery volume a
 * single bad page or API hiccup must not abort the run.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

/**
 * Collect only the successful values from mapWithConcurrency, flattening arrays.
 */
async function collectWithConcurrency(items, limit, worker) {
  const settled = await mapWithConcurrency(items, limit, worker);
  const out = [];
  for (const entry of settled) {
    if (!entry || !entry.ok || entry.value == null) continue;
    if (Array.isArray(entry.value)) out.push(...entry.value);
    else out.push(entry.value);
  }
  return out;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { mapWithConcurrency, collectWithConcurrency, sleep };
