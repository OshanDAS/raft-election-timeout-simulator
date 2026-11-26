/* =====================================================================
   SIMULATION CORE
   A line-by-line JavaScript port of the notebook model (sections 3-4.6).
   Names follow the notebook so the two can be compared side by side.
   Times are in milliseconds (ms).
   ===================================================================== */

const HEALTHY = 0, SLOW = 1, FAILED = 2;
const HEALTH_NAMES = ["healthy", "slow", "failed"];
const WORKING = 0, SLOW_WORKING = 1, NO_LEADER = 2;     // what the downtime meter sees (A15)
const FOLLOWER = "follower", CANDIDATE = "candidate", LEADER = "leader";

const DEFAULT_PARAMS = Object.freeze({
  n_nodes: 5,
  heartbeat_interval_ms: 100.0,     // h (etcd default)
  election_timeout_ms: 1000.0,      // T (etcd default)
  timeout_spread: 2.0,              // timer ~ Uniform[T, 2T]  (A4)
  fixed_delay_ms: 5.0,              // d
  delay_kind: "constant",           // "constant" | "exponential" | "lognormal" | "pareto"
  jitter_mean_ms: 0.0,              // m
  lognormal_sigma: 1.0,
  pareto_alpha: 2.5,
  health_chain_on: false,
  health_step_ms: 1000.0,           // Delta
  health_P: [[0.990, 0.007, 0.003],
             [0.050, 0.940, 0.010],
             [0.100, 0.000, 0.900]],
  slow_extra_delay_ms: 150.0,       // s
  slow_weight: 0.5,                 // w
  slow_heartbeat_wait: false,       // optional mode A14
});

function makeParams(overrides) {
  const p = Object.assign({}, DEFAULT_PARAMS, overrides || {});
  for (const row of p.health_P) {
    const sum = row.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new Error("each row of the transition matrix must sum to 1");
  }
  if (p.pareto_alpha <= 1) throw new Error("Pareto alpha must exceed 1 for a finite mean");
  return Object.freeze(p);
}

/* ---------- Random numbers: one seeded stream per purpose and node (A12) ---------- */
const STREAM_IDS = { timer: 0, delay: 1, slow: 2, health: 3, slow_wait: 4 };

function mix32(h) {                      // integer hash (murmur3 finaliser)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

class RNG {                              // xoshiro128** generator, seeded through splitmix32
  constructor(seed, purpose, node) {
    let x = mix32(mix32(mix32(seed >>> 0) ^ Math.imul(purpose + 1, 0x9e3779b9)) ^ Math.imul(node + 1, 0x7f4a7c15));
    const next = () => {                 // splitmix32 to fill the state
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s = [next(), next(), next(), next()];
    this._spare = null;
  }
  _next32() {
    const s = this.s;
    const result = Math.imul(((Math.imul(s[1], 5) << 7) | (Math.imul(s[1], 5) >>> 25)), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return result;
  }
  random() {                             // Uniform[0, 1) with 53-bit resolution
    const hi = this._next32() >>> 5, lo = this._next32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }
  uniform(a, b) { return a + (b - a) * this.random(); }
  standardNormal() {                     // Box-Muller
    if (this._spare !== null) { const z = this._spare; this._spare = null; return z; }
    let u = 0;
    while (u === 0) u = this.random();
    const v = this.random();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/* ---------- Event engine: next-event time advance (notebook 4.2) ---------- */
class EventHeap {                        // binary min-heap ordered by (time, seq)
  constructor() { this.a = []; }
  get length() { return this.a.length; }
  peek() { return this.a[0]; }
  static less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!EventHeap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && EventHeap.less(a[l], a[m])) m = l;
        if (r < a.length && EventHeap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

class Simulator {
  constructor(seed) {
    this.now = 0.0;
    this.seed = seed;
    this.queue = new EventHeap();        // future event list
    this.seq = 0;                        // tie-breaker
    this.handlers = {};
    this.events_processed = 0;
  }
  stream(purpose, node) { return new RNG(this.seed, STREAM_IDS[purpose], node); }
  on(kind, handler) { this.handlers[kind] = handler; }
  schedule(delay_ms, kind, data) {
    if (delay_ms < 0) throw new Error("cannot schedule an event in the past");
    this.queue.push([this.now + delay_ms, this.seq++, kind, data || {}]);
  }
  run(until_ms) {                        // process events in time order up to until_ms (inclusive)
    while (this.queue.length && this.queue.peek()[0] <= until_ms) {
      const [time, , kind, data] = this.queue.pop();
      if (time < this.now) throw new Error("clock went backwards");
      this.now = time;                   // the clock jumps to the event time
      this.handlers[kind](data);
      this.events_processed++;
    }
  }
}

/* ---------- Input modelling: jitter and health draws (notebook 4.2, 4.3) ---------- */
function drawJitter(rng, kind, mean_ms, sigma = 1.0, pareto_alpha = 2.5) {
  if (kind === "constant" || mean_ms === 0) return 0.0;
  if (kind === "exponential") return -mean_ms * Math.log(1 - rng.random());           // inverse transform
  if (kind === "lognormal") {
    const mu = Math.log(mean_ms) - sigma * sigma / 2;                                  // E[J] = mean_ms
    return Math.exp(mu + sigma * rng.standardNormal());
  }
  if (kind === "pareto") {
    const scale = mean_ms * (pareto_alpha - 1) / pareto_alpha;                         // E[J] = mean_ms
    const u = Math.max(rng.random(), Number.MIN_VALUE);
    return scale / Math.pow(1 - u, 1 / pareto_alpha);
  }
  throw new Error("unknown delay kind: " + kind);
}

function drawState(rng, probs) {          // discrete inverse transform
  const u = rng.random();
  let cumulative = 0;
  for (let s = 0; s < probs.length; s++) {
    cumulative += probs[s];
    if (u < cumulative) return s;
  }
  for (let s = probs.length - 1; s >= 0; s--) if (probs[s] > 0) return s;               // rounding only
  return 0;
}

function stationaryDistribution(P) {     // solve pi P = pi, sum(pi) = 1 (Gaussian elimination)
  const k = P.length;
  const A = [];
  for (let i = 0; i < k; i++) {          // rows of (P^T - I); the last row is replaced by the sum condition
    const row = [];
    for (let j = 0; j < k; j++) row.push(P[j][i] - (i === j ? 1 : 0));
    row.push(0);
    A.push(row);
  }
  A[k - 1] = new Array(k).fill(1).concat([1]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

/* ---------- The cluster (notebook 4.4 and 4.6) ---------- */
class Cluster {
  constructor(sim, params, opts = {}) {
    this.sim = sim;
    this.p = params;
    const n = params.n_nodes;
    this.majority = Math.floor(n / 2) + 1;
    this.term = new Array(n).fill(1);
    this.role = new Array(n).fill(FOLLOWER);
    this.voted_for = new Array(n).fill(null);
    this.granted_by = Array.from({ length: n }, () => new Set());
    this.timer_version = new Array(n).fill(0);
    this.timer_deadline = new Array(n).fill(null);      // for drawing the timers
    this.timer_length = new Array(n).fill(null);
    this.health = new Array(n).fill(HEALTHY);
    this.crashed = new Set();
    this.leaders_by_term = new Map();
    this.leader_log = [];
    this.elections_started = 0;
    this.heartbeats_sent = 0;
    this.heartbeats_accepted = 0;
    this.slow_waits = 0;
    this.notes = opts.keepNotes ? [] : null;             // readable story (live mode)
    this.heartbeat_arrivals = opts.keepArrivals ? [] : null;
    this.state_log = opts.keepStates ? [] : null;        // (time, meter state) at every meter change
    // downtime meter (A15 - A17)
    this.meter_ms = [0, 0, 0];
    this._meter_state = null;
    this._meter_since = 0;
    this._outage_start = null;
    this.outage_lengths = [];
    this.open_outage_ms = 0;
    this.meter_changes = 0;
    this.elections_false = 0;
    this.elections_slow = 0;
    this.elections_needed = 0;
    // one stream per purpose and node (A12)
    const mk = (purpose) => Array.from({ length: n }, (_, i) => sim.stream(purpose, i));
    this._timer_rng = mk("timer");
    this._delay_rng = mk("delay");
    this._slow_rng = mk("slow");
    this._health_rng = mk("health");
    this._wait_rng = mk("slow_wait");
    sim.on("heartbeat_send", (d) => this._on_heartbeat_send(d));
    sim.on("heartbeat_arrive", (d) => this._on_heartbeat_arrive(d));
    sim.on("vote_request_arrive", (d) => this._on_vote_request_arrive(d));
    sim.on("vote_reply_arrive", (d) => this._on_vote_reply_arrive(d));
    sim.on("timeout_fire", (d) => this._on_timeout_fire(d));
    sim.on("health_tick", (d) => this._on_health_tick(d));
    sim.on("set_health", (d) => this._set_health(d.node, d.state));
  }

  start(initial_health) {
    const n = this.p.n_nodes;
    if (this.p.health_chain_on) {
      const pi = stationaryDistribution(this.p.health_P);
      for (let node = 0; node < n; node++) {
        const rng = this._health_rng[node];
        this._set_initial_health(node, drawState(rng, pi));                 // A8
        const offset = rng.uniform(0, this.p.health_step_ms);               // A9
        this.sim.schedule(offset, "health_tick", { node });
      }
    }
    for (const [node, state] of Object.entries(initial_health || {})) this._set_initial_health(Number(node), state);
    if (this.health[0] !== FAILED) {                                         // A2
      this.voted_for[0] = 0;
      this._become_leader(0, 1);
    }
    for (let node = 1; node < n; node++) this._reset_timer(node);
    this._meter_update();
  }

  _set_initial_health(node, state) {
    this.health[node] = state;
    if (state === FAILED) this.crashed.add(node);
  }

  finish(until_ms) {
    if (this._meter_state !== null) {
      this.meter_ms[this._meter_state] += until_ms - this._meter_since;
      if (this._meter_state === NO_LEADER) this.open_outage_ms = until_ms - this._outage_start;   // A16
      this._meter_since = until_ms;
    }
  }

  newestLeader() {                       // A15: the Leader-role node with the highest term
    let newest = null;
    for (let node = 0; node < this.p.n_nodes; node++)
      if (this.role[node] === LEADER && (newest === null || this.term[node] > this.term[newest])) newest = node;
    return newest;
  }

  _working_state() {
    const newest = this.newestLeader();
    if (newest === null || this.health[newest] === FAILED) return NO_LEADER;
    return this.health[newest] === SLOW ? SLOW_WORKING : WORKING;
  }

  _meter_update() {
    const now = this.sim.now, nw = this._working_state();
    if (this._meter_state === null) {
      this._meter_state = nw; this._meter_since = now;
      if (nw === NO_LEADER) this._outage_start = now;
      if (this.state_log) this.state_log.push([now, nw]);
      return;
    }
    if (nw === this._meter_state) return;
    this.meter_ms[this._meter_state] += now - this._meter_since;
    if (this._meter_state === NO_LEADER) this.outage_lengths.push(now - this._outage_start);
    if (nw === NO_LEADER) this._outage_start = now;
    this._meter_state = nw; this._meter_since = now;
    this.meter_changes++;
    if (this.state_log) this.state_log.push([now, nw]);
  }

  /* Meter totals at time t (t >= last event), for the live display. */
  meterAt(t) {
    const m = this.meter_ms.slice();
    if (this._meter_state !== null) m[this._meter_state] += Math.max(0, t - this._meter_since);
    return m;
  }

  metrics(w) {
    w = (w === undefined) ? this.p.slow_weight : w;
    const none_s = this.meter_ms[NO_LEADER] / 1000, slow_s = this.meter_ms[SLOW_WORKING] / 1000;
    return {
      downtime_s: none_s + w * slow_s, none_s, slow_s,
      false_elections: this.elections_false, slow_elections: this.elections_slow,
      needed_elections: this.elections_needed, outages: this.outage_lengths.length,
      outage_ms_total: this.outage_lengths.reduce((a, b) => a + b, 0), open_outage_ms: this.open_outage_ms,
    };
  }

  _note(text) {
    if (this.notes) {
      this.notes.push([this.sim.now, text]);
      if (this.notes.length > 300) this.notes.splice(0, this.notes.length - 300);
    }
  }

  _delay(sender, kind) {                 // D = d + J (+ E if the sender is Slow, A11 / A14)
    const p = this.p;
    let d = p.fixed_delay_ms + drawJitter(this._delay_rng[sender], p.delay_kind, p.jitter_mean_ms, p.lognormal_sigma, p.pareto_alpha);
    if (this.health[sender] === SLOW && !(p.slow_heartbeat_wait && kind === "heartbeat_arrive"))
      d += drawJitter(this._slow_rng[sender], "exponential", p.slow_extra_delay_ms);
    return d;
  }

  _send(sender, kind, dst, data) {
    const delay = this._delay(sender, kind);
    data.dst = dst; data.src = sender; data.sent_at = this.sim.now; data.arrive_at = this.sim.now + delay;
    this.sim.schedule(delay, kind, data);
  }

  _reset_timer(node) {
    this.timer_version[node]++;
    const low = this.p.election_timeout_ms, high = this.p.timeout_spread * this.p.election_timeout_ms;
    const timeout = this._timer_rng[node].uniform(low, high);
    this.timer_deadline[node] = this.sim.now + timeout;
    this.timer_length[node] = timeout;
    this.sim.schedule(timeout, "timeout_fire", { node, version: this.timer_version[node] });
  }

  // ---- node health ----
  _on_health_tick({ node }) {
    const old = this.health[node];
    this._set_health(node, drawState(this._health_rng[node], this.p.health_P[old]));
    this.sim.schedule(this.p.health_step_ms, "health_tick", { node });
  }

  _set_health(node, nw) {
    const old = this.health[node];
    if (nw === old) return;
    this.health[node] = nw;
    this._note(`node ${node} health: ${HEALTH_NAMES[old]} → ${HEALTH_NAMES[nw]}`);
    if (nw === FAILED) this.crashed.add(node);
    else if (old === FAILED) { this.crashed.delete(node); this._recover(node); }
    this._meter_update();
  }

  _recover(node) {                       // A10
    this.role[node] = FOLLOWER;
    this.granted_by[node] = new Set();
    this._reset_timer(node);
    this._note(`node ${node} recovers as a follower in term ${this.term[node]}`);
  }

  // ---- term, role and voting rules ----
  _observe_term(node, term) {            // rule 1
    if (term > this.term[node]) {
      this.term[node] = term;
      this.voted_for[node] = null;
      if (this.role[node] !== FOLLOWER) {
        const wasLeader = this.role[node] === LEADER;
        this._note(`node ${node} steps down (sees term ${term})`);
        this.role[node] = FOLLOWER;
        this._reset_timer(node);
        if (wasLeader) this._meter_update();
      }
    }
  }

  _may_grant(node, term, candidate) {    // rule 3
    return term === this.term[node] && (this.voted_for[node] === null || this.voted_for[node] === candidate);
  }

  _become_leader(node, term) {
    this.role[node] = LEADER;
    this.timer_version[node]++;
    this.timer_deadline[node] = null;
    if (!this.leaders_by_term.has(term)) this.leaders_by_term.set(term, new Set());
    const holders = this.leaders_by_term.get(term);
    holders.add(node);
    if (holders.size > 1) throw new Error(`SAFETY VIOLATION: two leaders in term ${term}`);
    this.leader_log.push([this.sim.now, node, term]);
    this._note(`node ${node} becomes LEADER of term ${term}`);
    this._meter_update();
    this.sim.schedule(0, "heartbeat_send", { node, term });
  }

  _start_election(node) {                // rule 2 (A17 classifies the election first)
    const state = this._working_state();
    let label;
    if (state === WORKING) { this.elections_false++; label = "unnecessary"; }
    else if (state === SLOW_WORKING) { this.elections_slow++; label = "slow-leader replacement"; }
    else { this.elections_needed++; label = "needed"; }
    this.elections_started++;
    this.term[node]++;
    this.role[node] = CANDIDATE;
    this.voted_for[node] = node;
    this.granted_by[node] = new Set();
    this._reset_timer(node);
    this._note(`node ${node} times out → election for term ${this.term[node]} (${label})`);
    for (let dst = 0; dst < this.p.n_nodes; dst++)
      if (dst !== node) this._send(node, "vote_request_arrive", dst, { term: this.term[node], candidate: node });
  }

  // ---- event handlers ----
  _on_heartbeat_send({ node, term }) {
    if (this.crashed.has(node) || this.role[node] !== LEADER || this.term[node] !== term) return;
    this.heartbeats_sent++;
    for (let dst = 0; dst < this.p.n_nodes; dst++)
      if (dst !== node) this._send(node, "heartbeat_arrive", dst, { term, leader: node });
    let gap = this.p.heartbeat_interval_ms;
    if (this.p.slow_heartbeat_wait && this.health[node] === SLOW) {            // A14
      gap += drawJitter(this._wait_rng[node], "exponential", this.p.slow_extra_delay_ms);
      this.slow_waits++;
    }
    this.sim.schedule(gap, "heartbeat_send", { node, term });
  }

  _on_heartbeat_arrive({ dst, term, sent_at }) {
    if (this.heartbeat_arrivals) this.heartbeat_arrivals.push([dst, sent_at, this.sim.now]);
    if (this.crashed.has(dst) || term < this.term[dst]) return;               // rule 5
    this._observe_term(dst, term);
    this.role[dst] = FOLLOWER;
    this.heartbeats_accepted++;
    this._reset_timer(dst);
  }

  _on_vote_request_arrive({ dst, term, candidate }) {
    if (this.crashed.has(dst)) return;
    this._observe_term(dst, term);
    const grant = this._may_grant(dst, term, candidate);
    if (grant) { this.voted_for[dst] = candidate; this._reset_timer(dst); }
    this._send(dst, "vote_reply_arrive", candidate, { term: this.term[dst], granted: grant, voter: dst });
  }

  _on_vote_reply_arrive({ dst, term, granted, voter }) {
    if (this.crashed.has(dst)) return;
    if (term > this.term[dst]) { this._observe_term(dst, term); return; }
    if (this.role[dst] !== CANDIDATE || term !== this.term[dst]) return;
    if (granted) {
      this.granted_by[dst].add(voter);
      if (this.granted_by[dst].size + 1 >= this.majority) this._become_leader(dst, term);
    }
  }

  _on_timeout_fire({ node, version }) {
    if (this.crashed.has(node) || version !== this.timer_version[node]) return;
    this._start_election(node);
  }
}

function runCluster(params, duration_ms, seed, opts = {}) {
  const sim = new Simulator(seed);
  const cluster = new Cluster(sim, params, opts);
  cluster.start(opts.initial_health);
  if (opts.crash) sim.schedule(opts.crash[1], "set_health", { node: opts.crash[0], state: FAILED });
  sim.run(duration_ms);
  cluster.finish(duration_ms);
  return { sim, cluster };
}

/* ---------- Replications and confidence intervals (notebook 4.6) ---------- */
const T975 = [NaN, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
  2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
  2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423];

function t975(df) {                      // 97.5% point of Student's t (table up to 30, expansion beyond)
  if (df <= 30) {
    const lo = Math.max(1, Math.floor(df)), hi = Math.min(30, Math.ceil(df));
    if (lo === hi) return T975[lo];
    const f = (1 / df - 1 / lo) / (1 / hi - 1 / lo);          // interpolate in 1/df
    return T975[lo] + f * (T975[hi] - T975[lo]);
  }
  const z = 1.959963985, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
           + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

function meanCI(values) {                // mean and 95% t half-width; NaN entries are left out
  const x = values.filter((v) => !Number.isNaN(v));
  const n = x.length;
  if (n === 0) return { mean: NaN, half: NaN, sd: NaN, n };
  const mean = x.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, half: NaN, sd: NaN, n };
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, half: t975(n - 1) * sd / Math.sqrt(n), sd, n };
}

/* Welch interval from two summaries {mean, sd, n}. tied = means cannot be told apart at 95%. */
function welchTied(a, b) {
  const va = a.sd ** 2 / a.n, vb = b.sd ** 2 / b.n;
  const diff = a.mean - b.mean;
  if (va + vb === 0) return { diff, half: 0, tied: diff === 0 };
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const half = t975(df) * Math.sqrt(va + vb);
  return { diff, half, tied: Math.abs(diff) <= half };
}

function runOne(params, duration_ms, seed) {
  return runCluster(params, duration_ms, seed).cluster.metrics();
}

/* ---------- Notebook reference results (section 6.3, 30 runs x 10 min, s = 300 ms, w = 0.5) ----------
   [T, downtime % mean, half-width, false elections mean, half-width, slow replacements mean, half-width] */
const NOTEBOOK_SWEEP = {
  "late messages|5": [[150, 0.30, 0.15, 0.2, 0.2, 5.5, 1.3], [200, 0.35, 0.14, 0.2, 0.2, 5.2, 1.2], [300, 0.80, 0.18, 0.0, 0.0, 4.0, 0.9], [500, 5.05, 1.16, 0.0, 0.0, 0.3, 0.2], [800, 5.20, 1.22, 0.0, 0.0, 0.1, 0.1], [1500, 5.95, 1.29, 0.0, 0.0, 0.0, 0.1], [3000, 6.91, 1.53, 0.0, 0.0, 0.0, 0.0]],
  "late messages|20": [[150, 1.37, 0.27, 120.0, 4.2, 21.5, 3.4], [200, 0.43, 0.20, 3.0, 0.7, 5.7, 1.1], [300, 0.99, 0.25, 0.0, 0.0, 4.0, 0.9], [500, 5.02, 1.26, 0.0, 0.0, 0.4, 0.2], [800, 5.44, 1.25, 0.0, 0.0, 0.1, 0.1], [1500, 6.27, 1.30, 0.0, 0.0, 0.1, 0.1], [3000, 6.96, 1.44, 0.0, 0.0, 0.0, 0.0]],
  "late messages|50": [[150, 11.26, 0.80, 828.0, 11.1, 73.2, 8.3], [200, 2.51, 0.37, 122.6, 4.4, 21.9, 3.4], [300, 0.94, 0.22, 0.8, 0.4, 4.7, 1.0], [500, 5.09, 0.96, 0.1, 0.1, 0.4, 0.2], [800, 5.17, 1.13, 0.0, 0.0, 0.0, 0.1], [1500, 5.71, 1.31, 0.0, 0.0, 0.0, 0.0], [3000, 6.83, 1.33, 0.0, 0.1, 0.0, 0.0]],
  "late heartbeats|5": [[150, 0.33, 0.16, 0.3, 0.3, 5.6, 1.0], [200, 0.42, 0.16, 0.1, 0.1, 6.1, 1.1], [300, 0.52, 0.14, 0.1, 0.1, 5.1, 0.9], [500, 0.93, 0.21, 0.1, 0.1, 4.5, 0.8], [800, 2.18, 0.36, 0.2, 0.2, 3.0, 0.6], [1500, 5.80, 1.08, 0.1, 0.1, 0.6, 0.3], [3000, 6.35, 1.19, 0.0, 0.0, 0.0, 0.0]],
  "late heartbeats|20": [[150, 1.51, 0.21, 121.8, 4.1, 19.3, 2.4], [200, 0.50, 0.17, 2.8, 0.7, 6.3, 1.1], [300, 0.55, 0.13, 0.1, 0.1, 5.4, 1.1], [500, 1.04, 0.19, 0.1, 0.1, 5.0, 0.9], [800, 2.15, 0.36, 0.1, 0.2, 3.6, 0.7], [1500, 5.06, 1.02, 0.1, 0.1, 0.5, 0.3], [3000, 6.88, 1.23, 0.0, 0.0, 0.0, 0.0]],
  "late heartbeats|50": [[150, 11.83, 0.90, 819.9, 15.0, 69.8, 7.0], [200, 2.70, 0.38, 123.2, 4.9, 22.0, 3.6], [300, 0.74, 0.19, 1.2, 0.4, 5.9, 1.1], [500, 1.20, 0.27, 0.2, 0.2, 5.1, 1.3], [800, 2.24, 0.47, 0.2, 0.1, 3.8, 0.8], [1500, 6.00, 1.21, 0.0, 0.1, 0.6, 0.4], [3000, 6.82, 1.30, 0.0, 0.1, 0.0, 0.0]],
};
const NOTEBOOK_N = 30;
const SWEEP_T = [150, 200, 300, 500, 800, 1500, 3000];

/* The sweep setting of notebook 6.3 for one cell. */
function sweepParams(mode, jitter, T) {
  return makeParams({
    health_chain_on: true, election_timeout_ms: T, slow_extra_delay_ms: 300,
    slow_heartbeat_wait: mode === "late heartbeats", delay_kind: "exponential", jitter_mean_ms: jitter,
  });
}

/* Summary {mean, sd, n} of a notebook cell (sd recovered from the printed half-width). */
function notebookSummary(row, col) {
  const mean = row[col], half = row[col + 1];
  return { mean, half, sd: half * Math.sqrt(NOTEBOOK_N) / t975(NOTEBOOK_N - 1), n: NOTEBOOK_N };
}

if (typeof module !== "undefined") {
  module.exports = { HEALTHY, SLOW, FAILED, WORKING, SLOW_WORKING, NO_LEADER, LEADER, CANDIDATE, FOLLOWER,
    DEFAULT_PARAMS, makeParams, RNG, Simulator, Cluster, runCluster, runOne, drawJitter, drawState,
    stationaryDistribution, meanCI, welchTied, t975, NOTEBOOK_SWEEP, SWEEP_T, sweepParams, notebookSummary };
}

/* =====================================================================
   USER INTERFACE
   Live animation, controls, charts, replications and verification checks.
   ===================================================================== */
(function () {
  if (typeof document === "undefined") return;           // lets the core be tested outside a browser
  const $ = (id) => document.getElementById(id);

  const COL = {
    accent: "#1f6f8b", ink: "#1b2430", muted: "#5d6876", line: "#d8dee6",
    healthy: "#1a7f37", slow: "#c27c0e", failed: "#c62828", candidate: "#7b4fb5",
    stH: "#8fd19e", stS: "#f2c46d", stN: "#ef8a80", reply: "#2e9e57", grey: "#9aa4b1",
  };
  const RING = [COL.healthy, COL.slow, COL.failed];
  const REF = { mode: "late messages", jitter: 20, T: 200 };
  const REF_RESULT = { mean: 0.40, half: 0.11 };          // demo result for the reference setting, seeds 0-29

  const ui = {
    running: false, finished: false, busy: false,
    sim: null, cluster: null, params: null,
    t: 0, last: null, speed: 2, runLenMs: 600000,
    series: [], nextSample: 0, dirty: true, logCount: -1,
  };

  /* ---------- parameters ---------- */
  function readParams() {
    return makeParams({
      n_nodes: Number($("n").value),
      election_timeout_ms: Number($("T").value),
      delay_kind: $("dist").value,
      jitter_mean_ms: Number($("m").value),
      slow_extra_delay_ms: Number($("s").value),
      slow_heartbeat_wait: $("mode").value === "late heartbeats",
      slow_weight: Number($("w").value),
      health_chain_on: $("chain").checked,
    });
  }
  const speedFromSlider = (v) => 0.05 * Math.pow(4000, v / 100);    // 0.05x ... 200x
  function fmtSpeed(x) { return "×" + (x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : Math.round(x)); }

  function syncLabels() {
    $("TVal").textContent = $("T").value;
    $("mVal").textContent = $("m").value;
    $("sVal").textContent = $("s").value;
    $("wVal").textContent = Number($("w").value).toFixed(2);
    $("runLenVal").textContent = $("runLen").value;
    ui.speed = speedFromSlider(Number($("speed").value));
    $("speedVal").textContent = fmtSpeed(ui.speed);
    $("m").disabled = $("dist").value === "constant";
    $("msgHint").hidden = ui.speed <= 20;
  }

  /* ---------- live run ---------- */
  function resetLive() {
    ui.params = readParams();
    ui.runLenMs = Number($("runLen").value) * 60000;
    const seed = Math.max(0, Math.floor(Number($("seed").value) || 0));
    ui.sim = new Simulator(seed);
    ui.cluster = new Cluster(ui.sim, ui.params, { keepNotes: true, keepStates: true });
    try {
      ui.cluster.start();
      ui.sim.run(0);
    } catch (e) { showError(e); return; }
    ui.t = 0; ui.series = []; ui.nextSample = 0; ui.finished = false; ui.logCount = -1;
    ui.dirty = true;
    setStatus(ui.running ? "run" : "ready");
  }

  function setStatus(kind, text) {
    const el = $("status");
    el.className = "chip" + (kind === "run" ? " run" : kind === "done" ? " done" : kind === "err" ? " err" : "");
    el.textContent = text || { run: "Running", ready: "Ready", paused: "Paused", done: "Finished" }[kind] || kind;
    $("startBtn").textContent = ui.running ? "Pause" : (ui.finished ? "Restart" : (ui.t > 0 ? "Resume" : "Start"));
  }

  function showError(e) {
    ui.running = false;
    setStatus("err", "Error: " + e.message);
  }

  function toggleRun() {
    if (ui.busy) return;
    if (ui.finished) resetLive();
    ui.running = !ui.running;
    ui.last = null;
    setStatus(ui.running ? "run" : "paused");
  }

  function step(ts) {
    if (ui.running && !ui.busy) {
      if (ui.last !== null) {
        const dt = Math.min(100, ts - ui.last) * ui.speed;
        ui.t = Math.min(ui.runLenMs, ui.t + dt);
        try { ui.sim.run(ui.t); } catch (e) { showError(e); }
        sample();
        if (ui.t >= ui.runLenMs) { ui.running = false; ui.finished = true; setStatus("done"); }
        ui.dirty = true;
      }
      ui.last = ts;
    }
    if (ui.dirty) { drawCluster(); drawChart(); updateStats(); ui.dirty = false; }
    requestAnimationFrame(step);
  }

  function downtimeNow() {
    const m = ui.cluster.meterAt(ui.t);
    const w = ui.params.slow_weight;
    return { none: m[NO_LEADER], slow: m[SLOW_WORKING], pct: ui.t > 0 ? 100 * (m[NO_LEADER] + w * m[SLOW_WORKING]) / ui.t : 0 };
  }

  function sample() {
    const every = ui.runLenMs / 800;
    while (ui.nextSample <= ui.t) {
      const tt = ui.nextSample;
      if (tt > 0) {
        const m = ui.cluster.meterAt(Math.min(tt, ui.t));
        ui.series.push([tt, 100 * (m[NO_LEADER] + ui.params.slow_weight * m[SLOW_WORKING]) / tt]);
      }
      ui.nextSample += every;
    }
  }

  /* ---------- stats panel ---------- */
  function fmtS(ms) { return (ms / 1000).toFixed(1) + " s"; }
  function updateStats() {
    const c = ui.cluster;
    if (!c) return;
    const d = downtimeNow();
    $("oDown").textContent = d.pct.toFixed(2) + " %";
    $("oTime").textContent = fmtS(ui.t) + " / " + (ui.runLenMs / 60000) + " min";
    const L = c.newestLeader();
    const leaderText = (L === null || c.health[L] === FAILED) ? "none" : `node ${L} (${c.health[L] === SLOW ? "slow" : "healthy"})`;
    $("oLeader").textContent = leaderText;
    $("oLeader").style.color = (L === null || c.health[L] === FAILED) ? COL.failed : c.health[L] === SLOW ? COL.slow : COL.healthy;
    $("oTerm").textContent = Math.max(...c.term);
    $("oNone").textContent = fmtS(d.none);
    $("oSlow").textContent = fmtS(d.slow);
    $("oFalse").textContent = c.elections_false;
    $("oSlowEl").textContent = c.elections_slow;
    $("oNeeded").textContent = c.elections_needed;
    const k = c.outage_lengths.length;
    $("oOut").textContent = k + " / " + (k ? Math.round(c.outage_lengths.reduce((a, b) => a + b, 0) / k) + " ms" : "–");
    if (c.notes.length !== ui.logCount || c.notes.length === 300) {
      ui.logCount = c.notes.length;
      const items = c.notes.slice(-40).reverse();
      $("log").innerHTML = items.length
        ? items.map(([t, txt]) => `<li><span class="t">${(t / 1000).toFixed(3)} s</span>${txt}</li>`).join("")
        : `<li class="empty">Nothing yet. Press Start, or click a node to fail it.</li>`;
    }
  }

  /* ---------- canvas helpers ---------- */
  function fitCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: r.width, H: r.height };
  }

  function nodePositions(W, H, n) {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34;
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
  }

  /* ---------- cluster picture ---------- */
  function drawCluster() {
    const cv = $("clusterCanvas");
    const { ctx, W, H } = fitCanvas(cv);
    ctx.clearRect(0, 0, W, H);
    const c = ui.cluster;
    if (!c) return;
    const n = ui.params.n_nodes;
    const pos = nodePositions(W, H, n);
    const r = Math.max(18, Math.min(W, H) * 0.075);

    // links
    ctx.strokeStyle = "#e6eaef"; ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      ctx.beginPath(); ctx.moveTo(...pos[i]); ctx.lineTo(...pos[j]); ctx.stroke();
    }

    // messages in flight (read from the future event list)
    if (ui.speed <= 20) {
      for (const ev of ui.sim.queue.a) {
        const kind = ev[2], d = ev[3];
        if (kind !== "heartbeat_arrive" && kind !== "vote_request_arrive" && kind !== "vote_reply_arrive") continue;
        if (d.sent_at > ui.t) continue;
        const f = Math.min(1, Math.max(0, (ui.t - d.sent_at) / Math.max(1e-9, d.arrive_at - d.sent_at)));
        const [x0, y0] = pos[d.src], [x1, y1] = pos[d.dst];
        ctx.fillStyle = kind === "heartbeat_arrive" ? COL.accent : kind === "vote_request_arrive" ? COL.candidate : (d.granted ? COL.reply : COL.grey);
        ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, kind === "heartbeat_arrive" ? 4 : 5, 0, 2 * Math.PI); ctx.fill();
      }
    }

    // nodes
    const newest = c.newestLeader();
    for (let i = 0; i < n; i++) {
      const [x, y] = pos[i];
      const failed = c.health[i] === FAILED;
      // election timer arc
      if (!failed && c.role[i] !== LEADER && c.timer_deadline[i] !== null) {
        const left = Math.max(0, c.timer_deadline[i] - ui.t);
        const full = ui.params.timeout_spread * ui.params.election_timeout_ms;
        const frac = Math.min(1, left / full);
        ctx.strokeStyle = frac * full < 0.25 * ui.params.election_timeout_ms ? COL.slow : "#b4bcc6";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, r + 9, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI); ctx.stroke();
      }
      // body
      const role = c.role[i];
      ctx.fillStyle = failed ? "#eceff2" : role === LEADER ? COL.accent : role === CANDIDATE ? "#e9e0f5" : "#ffffff";
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = RING[c.health[i]];
      ctx.beginPath(); ctx.arc(x, y, r - 2.5, 0, 2 * Math.PI); ctx.stroke();
      if (role === CANDIDATE && !failed) { ctx.lineWidth = 2; ctx.strokeStyle = COL.candidate; ctx.beginPath(); ctx.arc(x, y, r - 7, 0, 2 * Math.PI); ctx.stroke(); }
      // label
      ctx.fillStyle = failed ? COL.muted : role === LEADER ? "#fff" : COL.ink;
      ctx.font = `600 ${Math.round(r * 0.55)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(failed ? "✕" : "N" + i, x, y);
      ctx.font = `${Math.max(10, Math.round(r * 0.36))}px system-ui, sans-serif`;
      ctx.fillStyle = COL.muted;
      const tag = failed ? "failed" : (role === LEADER ? (i === newest ? "leader" : "old leader") : role) + (c.health[i] === SLOW ? ", slow" : "");
      ctx.fillText(`${tag} · term ${c.term[i]}`, x, y + r + 21);
    }
  }

  /* ---------- downtime chart ---------- */
  function drawChart() {
    const cv = $("chartCanvas");
    const { ctx, W, H } = fitCanvas(cv);
    ctx.clearRect(0, 0, W, H);
    if (!ui.cluster) return;
    const L = 46, R = 24, T = 10, stripH = 18, B = 34;
    const plotH = H - T - B - stripH - 8;
    const x = (t) => L + (W - L - R) * t / ui.runLenMs;
    const pts = ui.series;
    const ymax = niceMax(Math.max(1, ...pts.map((p) => (p[0] > 5000 ? p[1] : 0))));
    const y = (v) => T + plotH * (1 - Math.min(v, ymax) / ymax);
    // grid and axes
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COL.muted; ctx.strokeStyle = "#eef1f4"; ctx.lineWidth = 1;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) {
      const v = ymax * k / 4;
      ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
      ctx.fillText(+v.toFixed(2) + "%", L - 6, y(v));
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const mins = ui.runLenMs / 60000;
    for (let k = 0; k <= mins; k++) ctx.fillText(k + " min", x(k * 60000), H - B + 6);
    // line
    ctx.strokeStyle = COL.accent; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    for (const [t, v] of pts) { if (t < 1000) continue; if (!started) { ctx.moveTo(x(t), y(v)); started = true; } else ctx.lineTo(x(t), y(v)); }
    ctx.stroke();
    // state strip
    const sy = T + plotH + 8;
    const log = ui.cluster.state_log;
    const stCol = [COL.stH, COL.stS, COL.stN];
    for (let i = 0; i < log.length; i++) {
      const t0 = log[i][0];
      if (t0 > ui.t) break;
      const t1 = Math.min(ui.t, i + 1 < log.length ? log[i + 1][0] : ui.t);
      ctx.fillStyle = stCol[log[i][1]];
      const xa = x(t0), xb = x(t1);
      ctx.fillRect(xa, sy, Math.max(xb - xa, log[i][1] === NO_LEADER ? 1 : 0), stripH);
    }
    ctx.strokeStyle = COL.line; ctx.strokeRect(L, sy, W - L - R, stripH);
    // now marker
    ctx.strokeStyle = COL.ink; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(ui.t), T); ctx.lineTo(x(ui.t), sy + stripH); ctx.stroke(); ctx.setLineDash([]);
  }

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
    return 10 * p;
  }

  /* ---------- clicking a node changes its health (test hook A7) ---------- */
  function onCanvasClick(ev) {
    if (!ui.cluster || ui.busy) return;
    const cv = $("clusterCanvas"), rect = cv.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const pos = nodePositions(rect.width, rect.height, ui.params.n_nodes);
    const r = Math.max(18, Math.min(rect.width, rect.height) * 0.075);
    pos.forEach(([x, y], i) => {
      if ((px - x) ** 2 + (py - y) ** 2 <= (r + 6) ** 2) {
        const next = (ui.cluster.health[i] + 1) % 3;
        try {
          ui.sim.schedule(Math.max(0, ui.t - ui.sim.now), "set_health", { node: i, state: next });
          ui.sim.run(ui.t);
        } catch (e) { showError(e); }
        ui.dirty = true;
      }
    });
  }

  /* ---------- batch work, in small chunks so the page stays responsive ---------- */
  function runJobs(jobs, label, outId, done) {
    ui.busy = true;
    const wasRunning = ui.running; ui.running = false;
    setButtons(false);
    $("progressWrap").hidden = false;
    const results = []; let i = 0;
    const tick = () => {
      const t0 = performance.now();
      try {
        while (i < jobs.length && performance.now() - t0 < 35) { results.push(jobs[i]()); i++; }
      } catch (e) {
        ui.busy = false; setButtons(true); $("progressWrap").hidden = true;
        $(outId).innerHTML = `<div class="verdict fail">Error: ${e.message}</div>`;
        return;
      }
      $("progressBar").style.width = (100 * i / jobs.length) + "%";
      $("progressText").textContent = `${label}: ${i} / ${jobs.length}`;
      if (i < jobs.length) setTimeout(tick, 0);
      else {
        ui.busy = false; setButtons(true); $("progressWrap").hidden = true;
        ui.running = wasRunning; ui.last = null;
        done(results);
      }
    };
    setTimeout(tick, 0);
  }
  function setButtons(on) { for (const id of ["repBtn", "rowBtn", "checkBtn", "startBtn", "resetBtn", "refBtn"]) $(id).disabled = !on; }

  const f = (x, d) => (Number.isNaN(x) ? "–" : x.toFixed(d));
  const ci = (s, d) => (s.n === 0 ? "–" : f(s.mean, d) + (Number.isNaN(s.half) ? "" : " ± " + f(s.half, d)));

  function matchNotebook(p, lenMs) {
    if (!p.health_chain_on || p.delay_kind !== "exponential" || p.slow_extra_delay_ms !== 300 || p.slow_weight !== 0.5 ||
        p.n_nodes !== 5 || lenMs !== 600000) return null;
    const key = (p.slow_heartbeat_wait ? "late heartbeats" : "late messages") + "|" + p.jitter_mean_ms;
    const rows = NOTEBOOK_SWEEP[key];
    if (!rows) return null;
    const row = rows.find((r) => r[0] === p.election_timeout_ms);
    return row ? { key, row } : null;
  }

  function runReplications() {
    const p = readParams();
    const N = Math.min(100, Math.max(2, Math.floor(Number($("reps").value) || 30)));
    const lenMs = Number($("runLen").value) * 60000;
    const seed0 = Math.max(0, Math.floor(Number($("seed").value) || 0));
    const jobs = Array.from({ length: N }, (_, i) => () => runOne(p, lenMs, seed0 + i));
    $("outRep").innerHTML = "";
    runJobs(jobs, "Replications", "outRep", (rows) => {
      const pct = rows.map((r) => 100 * r.downtime_s / (lenMs / 1000));
      const S = {
        down: meanCI(pct), none: meanCI(rows.map((r) => 100 * r.none_s / (lenMs / 1000))),
        slow: meanCI(rows.map((r) => 100 * r.slow_s / (lenMs / 1000))),
        fe: meanCI(rows.map((r) => r.false_elections)), se: meanCI(rows.map((r) => r.slow_elections)),
        ne: meanCI(rows.map((r) => r.needed_elections)),
        out: meanCI(rows.map((r) => (r.outages ? r.outage_ms_total / r.outages : NaN))),
      };
      const m = matchNotebook(p, lenMs);
      let html = `<table class="res"><tr><th>Result per run (${N} runs × ${lenMs / 60000} min, seeds ${seed0}–${seed0 + N - 1})</th><th>Demo mean ± 95% CI</th>${m ? "<th>Notebook §6.3</th>" : ""}</tr>
        <tr><td><b>Weighted downtime (%)</b></td><td><b>${ci(S.down, 2)}</b></td>${m ? `<td><b>${m.row[1].toFixed(2)} ± ${m.row[2].toFixed(2)}</b></td>` : ""}</tr>
        <tr><td>No working leader (% of run)</td><td>${ci(S.none, 2)}</td>${m ? "<td>–</td>" : ""}</tr>
        <tr><td>Slow working leader (% of run)</td><td>${ci(S.slow, 2)}</td>${m ? "<td>–</td>" : ""}</tr>
        <tr><td>Unnecessary elections</td><td>${ci(S.fe, 1)}</td>${m ? `<td>${m.row[3].toFixed(1)} ± ${m.row[4].toFixed(1)}</td>` : ""}</tr>
        <tr><td>Slow-leader replacements</td><td>${ci(S.se, 1)}</td>${m ? `<td>${m.row[5].toFixed(1)} ± ${m.row[6].toFixed(1)}</td>` : ""}</tr>
        <tr><td>Needed elections</td><td>${ci(S.ne, 1)}</td>${m ? "<td>–</td>" : ""}</tr>
        <tr><td>Mean outage length (ms)</td><td>${ci(S.out, 0)}</td>${m ? "<td>–</td>" : ""}</tr></table>`;
      if (m) {
        const w = welchTied(S.down, notebookSummary(m.row, 1));
        html += `<div class="verdict ${w.tied ? "pass" : "fail"}"><span class="${w.tied ? "pass-t" : "fail-t"}">${w.tied ? "PASS" : "FAIL"}</span>
          Downtime difference demo − notebook = ${w.diff.toFixed(2)} percentage points; 95% Welch half-width = ${w.half.toFixed(2)}.
          ${w.tied ? "The two means cannot be told apart, so the demo reproduces the notebook within the stated tolerance." : "The difference is larger than the tolerance."}</div>`;
      } else {
        html += `<div class="verdict info">There is no notebook reference value for these settings. Reference values exist for the main sweep only: exponential jitter m = 5, 20 or 50 ms, T = 150, 200, 300, 500, 800, 1500 or 3000 ms, s = 300 ms, w = 0.5, 5 nodes, random health on and 10-minute runs. Press <b>Load notebook reference setting</b> to set one up.</div>`;
      }
      $("outRep").innerHTML = html;
    });
  }

  function reproduceRow() {
    const key = $("rowSel").value;
    const [mode, j] = key.split("|");
    const N = Math.min(100, Math.max(2, Math.floor(Number($("reps").value) || 30)));
    const seed0 = Math.max(0, Math.floor(Number($("seed").value) || 0));
    const jobs = [];
    for (const T of SWEEP_T) {
      const p = sweepParams(mode, Number(j), T);
      for (let i = 0; i < N; i++) jobs.push(() => ({ T, pct: runOne(p, 600000, seed0 + i).downtime_s / 6 }));
    }
    $("outRow").innerHTML = ""; $("rowCanvas").hidden = true;
    runJobs(jobs, "Notebook row", "outRow", (res) => {
      const nb = NOTEBOOK_SWEEP[key];
      const demo = SWEEP_T.map((T) => meanCI(res.filter((r) => r.T === T).map((r) => r.pct)));
      const bestDemo = SWEEP_T[demo.reduce((b, s, i) => (s.mean < demo[b].mean ? i : b), 0)];
      const bestNb = nb.reduce((b, r) => (r[1] < b[1] ? r : b))[0];
      let tied = 0;
      let html = `<table class="res"><tr><th>T (ms)</th><th>Demo downtime % (${N} runs × 10 min)</th><th>Notebook §6.3 (30 runs)</th><th>Welch 95%</th></tr>`;
      SWEEP_T.forEach((T, i) => {
        const w = welchTied(demo[i], notebookSummary(nb[i], 1));
        if (w.tied) tied++;
        html += `<tr><td>${T}${T === bestDemo ? " ★" : ""}</td><td>${ci(demo[i], 2)}</td><td>${nb[i][1].toFixed(2)} ± ${nb[i][2].toFixed(2)}</td><td class="${w.tied ? "pass-t" : "fail-t"}">${w.tied ? "tied" : "differs"}</td></tr>`;
      });
      html += `</table><div class="verdict ${tied === 7 && bestDemo === bestNb ? "pass" : "info"}">
        <b>${tied} of 7</b> timeouts agree with the notebook (95% Welch interval). Best timeout: demo <b>${bestDemo} ms</b>, notebook <b>${bestNb} ms</b> (${mode}, m = ${j} ms). ★ = lowest demo downtime.</div>`;
      $("outRow").innerHTML = html;
      $("rowCanvas").hidden = false;
      drawRowChart(demo, nb, `${mode}, jitter m = ${j} ms`);
    });
  }

  function drawRowChart(demo, nb, title) {
    const { ctx, W, H } = fitCanvas($("rowCanvas"));
    ctx.clearRect(0, 0, W, H);
    const L = 46, R = 14, T = 24, B = 34;
    const ymax = niceMax(Math.max(...demo.map((s) => s.mean + (s.half || 0)), ...nb.map((r) => r[1] + r[2])));
    const lx = (T_) => L + (W - L - R) * (Math.log(T_) - Math.log(120)) / (Math.log(3600) - Math.log(120));
    const y = (v) => T + (H - T - B) * (1 - v / ymax);
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COL.muted; ctx.strokeStyle = "#eef1f4";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) { const v = ymax * k / 4; ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke(); ctx.fillText(+v.toFixed(2) + "%", L - 6, y(v)); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    SWEEP_T.forEach((T_) => ctx.fillText(T_, lx(T_), H - B + 6));
    ctx.fillText("election timeout T (ms, log scale)", (L + W - R) / 2, H - 14);
    ctx.textAlign = "left"; ctx.fillStyle = COL.ink; ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText("Weighted downtime vs timeout: " + title, L, 4);
    const series = [
      { col: COL.grey, off: -5, pts: nb.map((r) => [r[0], r[1], r[2]]), name: "notebook" },
      { col: COL.accent, off: 5, pts: SWEEP_T.map((T_, i) => [T_, demo[i].mean, demo[i].half]), name: "demo" },
    ];
    for (const s of series) {
      ctx.strokeStyle = s.col; ctx.fillStyle = s.col; ctx.lineWidth = 1.5;
      ctx.beginPath(); s.pts.forEach(([T_, m], i) => (i ? ctx.lineTo(lx(T_) + s.off, y(m)) : ctx.moveTo(lx(T_) + s.off, y(m)))); ctx.stroke();
      for (const [T_, m, h] of s.pts) {
        const xx = lx(T_) + s.off;
        ctx.beginPath(); ctx.moveTo(xx, y(m - h)); ctx.lineTo(xx, y(m + h)); ctx.stroke();
        ctx.beginPath(); ctx.arc(xx, y(m), 3.5, 0, 2 * Math.PI); ctx.fill();
      }
    }
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left";
    let lx0 = W - R;
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i], label = s.name + " ± 95% CI", tw = ctx.measureText(label).width;
      lx0 -= tw + 16;
      ctx.fillStyle = s.col; ctx.fillRect(lx0, 6, 10, 10); ctx.fillStyle = COL.ink; ctx.fillText(label, lx0 + 14, 5);
      lx0 -= 14;
    }
  }

  /* ---------- verification checks (a subset of notebook section 5) ---------- */
  function verificationJobs() {
    const P0 = makeParams({});
    return [
      () => {
        let ok = true;
        for (let s = 0; s < 20; s++) {
          const { cluster: c } = runCluster(P0, 60000, s);
          ok = ok && c.heartbeats_sent === 601 && c.heartbeats_accepted === 2400 && c.elections_started === 0;
        }
        return ["3", "Limiting case: no jitter, no failures, 60 s", "601 sends, 2400 accepted heartbeats, 0 elections (20 seeds)", ok ? "as expected for all 20 seeds" : "mismatch", ok];
      },
      () => {
        let el = 0;
        for (let s = 0; s < 5; s++) el += runCluster(makeParams({ heartbeat_interval_ms: 3000 }), 60000, s).cluster.elections_started;
        return ["4", "Negative control: heartbeat 3000 ms > longest timer 2000 ms", "elections must start", el + " elections", el > 0];
      },
      () => {
        let inside = 0, multi = 0, bad = 0;
        for (let s = 0; s < 100; s++) {
          const { cluster: c } = runCluster(P0, 60000, s, { crash: [0, 10050] });
          const nl = c.leader_log.find((e) => e[2] > 1);
          if (!nl) { bad++; continue; }
          if (c.elections_started === 1) { const dt = nl[0] - 10050; if (dt >= 965 - 1e-9 && dt <= 1965 + 1e-9) inside++; else bad++; } else multi++;
        }
        return ["5", "Leader fails at 10 050 ms", "new leader 965–1965 ms later (single candidate)", `${inside} inside, ${multi} split votes recovered, ${bad} outside`, bad === 0];
      },
      () => {
        let el = 0;
        const p = makeParams({ election_timeout_ms: 150, delay_kind: "exponential", jitter_mean_ms: 80 });
        for (let s = 0; s < 10; s++) el += runCluster(p, 60000, s).cluster.elections_started;
        return ["6", "Safety under stress (T = 150 ms, m = 80 ms)", "never two leaders in one term", `0 violations in ${el} elections`, true];
      },
      () => {
        const pi = stationaryDistribution(P0.health_P);
        const sh = 0.007 / 0.06, fh = 0.003 / 0.10 + 0.01 / 0.10 * sh, h = 1 / (1 + sh + fh);
        const ok = Math.abs(pi[0] - h) < 1e-9 && Math.abs(pi[1] - h * sh) < 1e-9 && Math.abs(pi[2] - h * fh) < 1e-9;
        return ["8", "Stationary distribution of the health chain", "(0.8633, 0.1007, 0.0360)", "(" + pi.map((v) => v.toFixed(4)).join(", ") + ")", ok];
      },
      () => {
        const p = makeParams({ delay_kind: "exponential", jitter_mean_ms: 20, slow_extra_delay_ms: 150 });
        const c = new Cluster(new Simulator(7), p);
        c.health[1] = SLOW;
        const N = 100000;
        let slow = 0, healthy = 0;
        for (let i = 0; i < N; i++) { slow += c._delay(1); healthy += c._delay(2); }
        slow /= N; healthy /= N;
        const seSlow = Math.sqrt(20 * 20 + 150 * 150) / Math.sqrt(N), seH = 20 / Math.sqrt(N);
        const ok = Math.abs(slow - 175) < 4 * seSlow && Math.abs(healthy - 25) < 4 * seH;
        return ["11", "Slow sender delay (m = 20, s = 150)", "mean 175 ms slow, 25 ms healthy", `${slow.toFixed(1)} ms, ${healthy.toFixed(1)} ms`, ok];
      },
      () => {
        const p = makeParams({ delay_kind: "exponential", jitter_mean_ms: 50, election_timeout_ms: 3000 });
        const taus = [100, 150, 200, 300, 400], cnt = [0, 0, 0, 0, 0];
        let pairs = 0;
        for (let s = 0; s < 5; s++) {
          const { cluster: c } = runCluster(p, 600000, s, { keepArrivals: true });
          const byNode = {};
          for (const [dst, sent, arr] of c.heartbeat_arrivals) (byNode[dst] = byNode[dst] || []).push([sent, arr]);
          for (const list of Object.values(byNode)) {
            list.sort((a, b) => a[0] - b[0]);
            for (let k = 0; k + 1 < list.length; k += 2) {        // every second difference: independent pairs
              const g = list[k + 1][1] - list[k][1];
              pairs++;
              taus.forEach((tau, i) => { if (g > tau) cnt[i]++; });
            }
          }
        }
        let ok = true;
        const parts = taus.map((tau, i) => {
          const exp = 0.5 * Math.exp(-(tau - 100) / 50), obs = cnt[i] / pairs;
          if (Math.abs(obs - exp) > 4 * Math.sqrt(exp * (1 - exp) / pairs)) ok = false;
          return `${tau}: ${obs.toFixed(4)} vs ${exp.toFixed(4)}`;
        });
        return ["17", "Heartbeat arrival gap, P(G > τ) = ½·e^(−(τ−h)/m)", "within 4 standard errors", parts.join("; "), ok];
      },
      () => {
        const p = sweepParams("late messages", 20, 300);
        const a = runOne(p, 120000, 3), b = runOne(p, 120000, 3);
        const ok = JSON.stringify(a) === JSON.stringify(b);
        return ["20", "Determinism: same seed twice", "identical results", ok ? "identical" : "different", ok];
      },
    ];
  }

  function runChecks() {
    $("outCheck").innerHTML = "";
    runJobs(verificationJobs(), "Verification checks", "outCheck", (rows) => {
      const passed = rows.filter((r) => r[4]).length;
      let html = `<table class="res"><tr><th>Notebook check</th><th>Expected</th><th>Obtained in the browser</th><th>Pass?</th></tr>`;
      for (const [num, name, exp, got, ok] of rows)
        html += `<tr><td>${num}. ${name}</td><td>${exp}</td><td>${got}</td><td class="${ok ? "pass-t" : "fail-t"}">${ok ? "yes" : "no"}</td></tr>`;
      html += `</table><div class="verdict ${passed === rows.length ? "pass" : "fail"}"><b>${passed} of ${rows.length}</b> checks pass. These repeat checks from notebook section 5 on the JavaScript port.</div>`;
      $("outCheck").innerHTML = html;
    });
  }

  /* ---------- tabs ---------- */
  function showTab(name) {
    const watch = name === "watch";
    $("paneWatch").hidden = !watch;
    $("paneCheck").hidden = watch;
    for (const [id, on] of [["tabWatch", watch], ["tabCheck", !watch]]) {
      $(id).classList.toggle("active", on);
      $(id).setAttribute("aria-selected", String(on));
    }
    if (!watch && ui.running) { ui.running = false; setStatus("paused"); }   // the live run pauses while you check
    ui.dirty = true;
  }

  /* ---------- wiring ---------- */
  function loadReference() {
    $("T").value = REF.T; $("dist").value = "exponential"; $("m").value = REF.jitter; $("s").value = 300;
    $("mode").value = REF.mode; $("w").value = 0.5; $("n").value = "5"; $("chain").checked = true;
    $("runLen").value = 10; $("reps").value = 30; $("seed").value = 0;
    $("rowSel").value = REF.mode + "|" + REF.jitter;
    syncLabels(); resetLive();
    $("outRep").innerHTML = `<div class="verdict info">Reference setting loaded. Press <b>Run replications</b>. Expected: about <b>${REF_RESULT.mean.toFixed(2)} ± ${REF_RESULT.half.toFixed(2)} %</b> (notebook: 0.43 ± 0.20 %).</div>`;
  }

  function init() {
    syncLabels();
    for (const id of ["T", "m", "s", "w", "runLen", "seed", "dist", "mode", "n", "chain"]) {
      $(id).addEventListener("input", () => { syncLabels(); resetLive(); });
    }
    $("speed").addEventListener("input", () => { syncLabels(); ui.dirty = true; });
    $("startBtn").addEventListener("click", toggleRun);
    $("resetBtn").addEventListener("click", () => { ui.running = false; resetLive(); setStatus("ready"); });
    $("refBtn").addEventListener("click", loadReference);
    $("repBtn").addEventListener("click", runReplications);
    $("rowBtn").addEventListener("click", reproduceRow);
    $("checkBtn").addEventListener("click", runChecks);
    $("clusterCanvas").addEventListener("click", onCanvasClick);
    $("tabWatch").addEventListener("click", () => showTab("watch"));
    $("tabCheck").addEventListener("click", () => showTab("check"));
    $("avgLink").addEventListener("click", () => {
      showTab("check");
      $("repBtn").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("aboutToggle").addEventListener("click", () => {
      const a = $("about"); a.hidden = !a.hidden;
      $("aboutToggle").setAttribute("aria-expanded", String(!a.hidden));
      ui.dirty = true;
    });
    window.addEventListener("resize", () => { ui.dirty = true; });
    resetLive();
    requestAnimationFrame(step);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
