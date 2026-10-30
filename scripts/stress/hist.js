/* A latency histogram that is cheap to fill and to merge across processes:
 * a count per bucket, the buckets 1 ms wide below 100 ms, 5 ms below 1 s,
 * 50 ms below 10 s and 500 ms above, so a percentile is never off by more
 * than one bucket.
 */

export class Hist {
  constructor(data) {
    this.counts = new Map(data?.counts ?? []);
    this.n = data?.n ?? 0;
    this.sum = data?.sum ?? 0;
    this.min = data?.n ? data.min : Infinity;
    this.max = data?.max ?? 0;
  }

  add(ms) {
    if (!Number.isFinite(ms)) return;
    const v = Math.max(0, ms);
    const b = bucket(v);
    this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
    this.n += 1;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  merge(other) {
    for (const [b, c] of other.counts) this.counts.set(b, (this.counts.get(b) ?? 0) + c);
    this.n += other.n;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
    return this;
  }

  /* The value p percent of the samples are at or below. */
  pct(p) {
    if (!this.n) return 0;
    const target = Math.max(1, Math.ceil((p / 100) * this.n));
    let seen = 0;
    for (const b of [...this.counts.keys()].sort((a, c) => a - c)) {
      seen += this.counts.get(b);
      if (seen >= target) return Math.min(b, this.max);
    }
    return this.max;
  }

  /* The share of samples at or below ms. */
  within(ms) {
    if (!this.n) return 1;
    let seen = 0;
    for (const [b, c] of this.counts) if (b <= ms) seen += c;
    return seen / this.n;
  }

  toJSON() {
    return { counts: [...this.counts], n: this.n, sum: this.sum, min: this.n ? this.min : 0, max: this.max };
  }
}

function bucket(v) {
  if (v < 100) return Math.ceil(v);
  if (v < 1000) return Math.ceil(v / 5) * 5;
  if (v < 10_000) return Math.ceil(v / 50) * 50;
  return Math.ceil(v / 500) * 500;
}
