# Theory and mathematics

This document explains the theory behind the notebook `raft-election-timeout-simulator.ipynb`. It covers what is modelled, what is assumed, the equations, how the simulation computes them, how the code was checked, and which simulation concepts are applied. All times are in **milliseconds (ms)** unless stated otherwise. Section numbers such as "notebook §6.3" point to the notebook.

---

## 1. Problem formulation

### 1.1 The system

A **Raft-style cluster** is a group of servers (here $n = 5$) that keep data consistent by electing one **leader**. Raft is the consensus algorithm used by etcd, the key-value store behind Kubernetes [1], [2].

- The leader sends a **heartbeat** (a short "I am alive" message) to every other server, the **followers**, every $h = 100$ ms (etcd default [2]).
- Each follower runs a countdown called the **election timeout**. If the countdown ends before a heartbeat arrives, the follower assumes the leader is gone and starts an **election** to choose a new leader.
- While there is no working leader, the service cannot accept writes. This time is **downtime**.

A leader can be in one of three **health states**:

| State | Meaning |
|---|---|
| Healthy (H) | Works normally. |
| Slow (S) | Alive but late, for example because of a slow disk or an overloaded CPU. |
| Failed (F) | Crashed. Sends nothing and ignores everything. |

The network between servers adds a random delay to every message. The random part is called **jitter**.

### 1.2 The trade-off

The election timeout $T$ is a tuning knob with two opposite risks:

- **$T$ too short:** a few heartbeats that are simply late because of jitter look like a dead leader. Followers start **unnecessary elections** (false suspicion), and each one briefly leaves the cluster without a leader.
- **$T$ too long:** when the leader really fails, the cluster waits a long time before replacing it. A **slow** leader may also never be replaced, so the service runs degraded for a long time.

### 1.3 Research question

> Which election-timeout setting minimises total service downtime when leaders can be healthy, slow or failed, and how does the best setting change as network jitter increases?

### 1.4 Quantities of interest

| Quantity | Definition | Unit |
|---|---|---|
| Weighted downtime | No-leader time + $w$ × slow-leader time (equation 7), reported as a % of the run | % |
| False (unnecessary) elections | Elections started while a **healthy** working leader existed | per run |
| Slow-leader replacements | Elections started while the working leader was **slow** | per run |
| Needed elections | Elections started while there was **no** working leader | per run |
| Mean outage length | Average length of one unbroken period with no working leader (the recovery time) | ms |

**Scope.** Timing only: heartbeats, timers, elections and node health. There is no log replication, no stored data and no real network.

---

## 2. Assumptions

| # | Assumption | Why it is reasonable |
|---|---|---|
| A1 | Timing-level model only: no log replication. | The question is about *when* elections happen, which depends only on timing. Leaving out the log keeps the model small enough to verify fully. |
| A2 | Node 0 is the leader of term 1 at time 0 (unless it starts Failed). | Gives every run a defined starting point, so no warm-up period is needed. |
| A3 | One-way delay = 5 ms fixed + random jitter (+ slow extra delay). Delays are independent, so messages can arrive out of order. Messages are never lost, except those arriving at a failed node. For Pareto jitter, $\alpha > 1$. | Independent delays are the standard simple network model. $\alpha > 1$ is needed for the mean to exist. Message loss is left out on purpose (see Limitations). |
| A4 | Each election timer is drawn from $\mathrm{Uniform}[T, 2T]$. | Raft requires *random* timeouts from a fixed interval so that two followers rarely time out together [1]. The range $T$ to $2T$ is this project's own choice; the Raft paper does not fix it. |
| A5 | A health state lasts at least one step, $\Delta = 1$ s. Shorter hiccups are treated as jitter. | Separates "the network is noisy" (jitter) from "the server itself is in trouble" (health). |
| A6 | Voting follows Raft rules but without the log up-to-date check. No heartbeat replies. | With no log (A1) the log check has nothing to compare. An old leader still learns about a newer term from vote requests and heartbeats. |
| A7 | Test hooks (`crash`, `health_events`, `initial_health`) can set a node's health by hand. | Used only in checks and in notebook §6.1, to force a known situation. In the full model the Markov chain sets health. |
| A8 | Each node's health at time 0 is drawn from the stationary distribution $\pi$. | The chain then starts "already in its long-run behaviour", so no warm-up is needed. |
| A9 | Node $i$ changes health at times $u_i + k\Delta$, with $u_i \sim \mathrm{Uniform}[0, \Delta)$. | Stops all nodes from changing state at exactly the same instant, which would be unrealistic. |
| A10 | A recovered node returns as a **follower** with its term and vote unchanged and a fresh random timer, even if it was the leader. | Real Raft saves the term and vote to disk [1], so they survive a crash. This also guarantees a node never votes twice in one term. |
| A11 | A Slow node's extra delay $E$ applies **only to messages it sends**. $E$ is exponential with mean $s$, drawn separately from the jitter. | A slow server is slow to *produce* messages. Keeping $E$ and $J$ separate is the whole point of the project: "noisy network" versus "slow node". |
| A12 | Each purpose (timer, delay, slow delay, slow heartbeat wait, health) and each node has its own random-number stream. | Changing one input (for example jitter) does not change the random numbers used for anything else. This is the variance-reduction idea of **common random numbers** [4]. |
| A13 | Downtime counts no-leader time with weight 1 and slow-leader time with weight $w = 0.5$. | A slow leader is worse than a healthy one but better than none. $w$ is swept (0, 0.5, 1) to test this choice. |
| A14 | Optional mode "late heartbeats" (off by default): a slow leader waits $h + W$, $W \sim \mathrm{Exp}(s)$, before its next heartbeat. | Models a leader that stalls *before sending*, for example on slow disk writes, which etcd's tuning guide describes [3]. Used to check that conclusions do not depend on one way of modelling slowness. |
| A15 | **Working leader:** the node in the Leader role with the highest term. If there is none, or it is Failed, there is no working leader. | Matches how clients see the cluster: an older, deposed leader no longer counts once a newer one exists. |
| A16 | The downtime meter runs from time 0 to the end of the run. An outage still running at the end counts in downtime but not in the list of completed outage lengths. | A2 and A8 give a defined start. A cut-off outage has an unknown true length, so it cannot be averaged. |
| A17 | An election is classified when its candidate times out: false (healthy working leader exists), slow-leader replacement (working leader is Slow) or needed (no working leader). Replications use seeds $0, 1, \dots, n-1$. Cells are compared with Welch's interval. | Classifying at the moment of timeout uses exactly what the follower "should" have known. Welch's interval is used because the measured correlation between cells was weak, so a paired comparison would not help. |

---

## 3. Model equations

### 3.1 Heartbeats

The leader of term $\tau$ sends heartbeat $k$ at

$$
t_k = t_0 + k\,h, \qquad k = 0, 1, 2, \dots \tag{1}
$$

It reaches follower $i$ at $t_k + D_{k,i}$, where $D_{k,i}$ is the one-way message delay.

### 3.2 Message delay

Every message gets an independent delay

$$
D = d + J + E \tag{2}
$$

- $d = 5$ ms is the fixed propagation part.
- $J \ge 0$ is the **network jitter**, with mean $m$.
- $E \ge 0$ is the **slow-node extra delay**. $E = 0$ unless the *sender* is Slow.

The jitter $J$ can take four shapes. $U \sim \mathrm{Uniform}[0,1)$ and $Z \sim N(0,1)$ are standard random numbers.

| Shape | Formula | Mean | Why it is used |
|---|---|---|---|
| Constant | $J = 0$ | 0 | Limiting case for checks. |
| Exponential | $J = -m\ln(1-U)$ | $m$ | Main experiments. Simple, one parameter. |
| Lognormal | $J = \exp(\mu + \sigma Z)$, $\mu = \ln m - \sigma^2/2$ | $m$ | Skewed, common for real latencies. |
| Pareto-I | $J = x_m / (1-U)^{1/\alpha}$, $x_m = m(\alpha-1)/\alpha$ | $m$ (needs $\alpha > 1$) | Heavy (power-law) tail: rare but very large delays. |

All three random shapes are **calibrated to the same mean** $m$. A comparison between them therefore changes only the *shape* of the delay, not its average.

**Why the exponential formula works (inverse-transform method).** The exponential CDF is $F(x) = 1 - e^{-x/m}$. Setting $U = F(J)$ and solving for $J$ gives $J = -m\ln(1-U)$. Since $U$ is uniform, $J$ then has exactly the CDF $F$.

**Slow extra delay.** $E = -s\ln(1-U')$, exponential with mean $s$, using a *separate* uniform $U'$ from its own stream (A11, A12).

So the mean delay of one message is

$$
\mathbb{E}[D] = d + m + s\cdot\mathbf{1}\{\text{sender is Slow}\}. \tag{3}
$$

### 3.3 Election timer

A follower restarts its timer each time it accepts a heartbeat or grants a vote. The timer length is

$$
T_i \sim \mathrm{Uniform}[T,\; 2T]. \tag{4}
$$

If the timer ends before it is reset, the node starts an election.

**Expected wait after a clean leader failure.** Four followers each draw a timer from $[T, 2T]$. The first to time out is the one with the smallest draw. For $k$ independent uniforms on $[0,1]$, the expected minimum is $1/(k+1)$. With $k = 4$:

$$
\mathbb{E}[\min_i T_i] = T + \frac{T}{5} = 1.2\,T. \tag{5}
$$

This explains why a clean failure takes about $1.2T$ to recover (notebook §7.4).

### 3.4 Election rules (simplified Raft)

1. Every node has a **term**, a number that only goes up. A node that sees a higher term adopts it and becomes a follower.
2. A node whose timer ends becomes a **candidate**. It adds 1 to its term, votes for itself, restarts its timer and asks the others for votes.
3. A node grants a vote only if the request's term equals its own and it has not already voted for someone else in that term. Each node votes **at most once per term**.
4. A candidate with a **majority** of votes becomes leader and sends a heartbeat immediately:

$$
\text{majority} = \left\lfloor \frac{n}{2} \right\rfloor + 1 \quad (= 3 \text{ for } n = 5,\; 2 \text{ for } n = 3). \tag{6}
$$

5. A heartbeat from a term at least as high as the node's own is accepted (a candidate steps down). A heartbeat from a lower term is ignored.

**Safety invariant (election safety).** At most one leader can exist in any one term. The code asserts this every time a node becomes leader.

### 3.5 Node health: a discrete-time Markov chain

Each node has its own **discrete-time Markov chain (DTMC)** on the states $\{H, S, F\}$. A Markov chain is a random process where the next state depends only on the current state, not on the past. The chain moves once every $\Delta = 1000$ ms:

$$
\Pr(X_{n+1} = j \mid X_n = i) = P_{ij}, \qquad \sum_j P_{ij} = 1.
$$

The default transition matrix (rows = from, columns = to, order H, S, F) is

$$
P = \begin{pmatrix}
0.990 & 0.007 & 0.003 \\
0.050 & 0.940 & 0.010 \\
0.100 & 0.000 & 0.900
\end{pmatrix}.
$$

These values are illustrative, not measured.

**Stationary distribution.** The long-run share of time in each state, $\pi$, solves

$$
\pi P = \pi, \qquad \sum_j \pi_j = 1.
$$

Worked by hand with the balance equations ("flow out of a state = flow into it"):

- Slow: $\pi_S(1 - 0.94) = 0.007\,\pi_H \Rightarrow \pi_S/\pi_H = 0.007/0.06 = 0.1167$
- Failed: $0.10\,\pi_F = 0.003\,\pi_H + 0.01\,\pi_S \Rightarrow \pi_F/\pi_H = 0.03 + 0.1 \times 0.1167 = 0.0417$
- Normalise: $\pi_H = 1/(1 + 0.1167 + 0.0417) = 0.8633$

$$
\pi = (\pi_H, \pi_S, \pi_F) = (0.8633,\; 0.1007,\; 0.0360).
$$

**Average stay** in state $i$ is $1/(1 - P_{ii})$ steps (a geometric distribution):

| State | Long-run share $\pi_i$ | Average stay |
|---|---|---|
| Healthy | 86.3% | 100 s |
| Slow | 10.1% | 16.7 s |
| Failed | 3.6% | 10 s |

**Drawing the next state (discrete inverse transform).** Draw $U$, add up the probabilities in row $P_{i\cdot}$ one by one, and pick the first state where the running total exceeds $U$.

**What each state does in the model:**

- **Healthy:** normal.
- **Slow, "late messages" (default, A11):** every message the node sends gets extra delay $E$. Its heartbeat loop runs on schedule.
- **Slow, "late heartbeats" (optional, A14):** a slow leader waits $h + W$, $W \sim \mathrm{Exp}(s)$, before its next heartbeat. Heartbeats get no extra per-message delay; vote messages still get $E$.
- **Failed:** ignores every event and sends nothing.
- **Recovery:** returns as a follower with the same term and vote (A10).

### 3.6 Downtime metric

With slow weight $w$ and run length $L$:

$$
\text{downtime} = \int_0^{L} \Big( \mathbf{1}\{\text{no working leader}\} + w\,\mathbf{1}\{\text{working leader is Slow}\} \Big)\,dt \tag{7}
$$

Because the indicator values only change at events, the integral is computed exactly as a sum of time intervals:

$$
\text{downtime} = t_{\text{no leader}} + w\,t_{\text{slow leader}}, \qquad \text{downtime \%} = 100 \times \frac{\text{downtime}}{L}. \tag{8}
$$

- $w = 0$: a slow leader costs nothing.
- $w = 1$: a slow leader costs as much as no leader.

Because equation (8) is linear in $w$, results for any $w$ can be recomputed from stored runs without new simulation.

### 3.7 False-suspicion formula

For exponential jitter, consecutive heartbeats $k$ and $k+1$ arrive

$$
G = h + J_{k+1} - J_k
$$

apart (the fixed part $d$ cancels). The difference of two independent exponentials with mean $m$ is a **Laplace** (two-sided exponential) variable, so for $\tau \ge h$:

$$
\Pr(G > \tau) = \tfrac{1}{2}\, e^{-(\tau - h)/m}. \tag{9}
$$

Larger $m$ makes long gaps more likely, so a longer timeout is needed to avoid false elections. Equation (9) explains the **direction** of the effect. It is **not** the probability of a false election, because any later heartbeat that arrives in time still resets the timer. (At $\tau = 300$ ms, $m = 50$ ms, the formula gives 0.0092, but the measured follower silence exceeds 300 ms only 0.00052 of the time.)

### 3.8 Monte Carlo estimation and confidence intervals

Each setting ("cell") is run $n$ times with independent seeds. For run-level values $x_1, \dots, x_n$ with mean $\bar{x}$ and sample standard deviation $s_x$, the 95% **Student-t confidence interval** is

$$
\bar{x} \pm t_{0.975,\,n-1}\,\frac{s_x}{\sqrt{n}}. \tag{10}
$$

The term $s_x/\sqrt{n}$ is the **Monte Carlo standard error**. By the law of large numbers and the central limit theorem it shrinks like $1/\sqrt{n}$: four times as many runs halves the error.

**Comparing two cells (Welch interval).** Two cells $a$ and $b$ are "tied" (cannot be told apart) if the interval

$$
(\bar{x}_a - \bar{x}_b) \pm t_{0.975,\,\nu}\sqrt{\frac{s_a^2}{n_a} + \frac{s_b^2}{n_b}} \tag{11}
$$

contains 0, with degrees of freedom from the **Welch-Satterthwaite** formula:

$$
\nu = \frac{\left(\dfrac{s_a^2}{n_a} + \dfrac{s_b^2}{n_b}\right)^2}{\dfrac{(s_a^2/n_a)^2}{n_a - 1} + \dfrac{(s_b^2/n_b)^2}{n_b - 1}}.
$$

Each comparison is made at 95% on its own, with no multiple-comparison correction.

**Share intervals.** In notebook §6.2, shares of slow-leader spells (e.g. "63% replaced") use a 95% **Wilson** interval for a proportion.

### 3.9 Symbol table

| Symbol | Meaning | Units | Value / range | Source |
|---|---|---|---|---|
| $n$ | Number of nodes in the cluster | – | 5 (3 in §6.5) | Common etcd size; [1] |
| $h$ | Heartbeat interval | ms | 100 | etcd default [2] |
| $T$ | Base election timeout | ms | 1000 default; swept 150–3000 | etcd default [2]; swept |
| $T_i$ | One follower's timer draw | ms | $\mathrm{Uniform}[T, 2T]$ | Own choice (A4) |
| $d$ | Fixed propagation delay | ms | 5 | Own choice |
| $J$ | Network jitter | ms | ≥ 0 | – |
| $m$ | Mean jitter | ms | 0, 5, 20, 50 (100 in §6.6) | Provisional |
| $\sigma$ | Lognormal shape | – | 1.0 | Own choice |
| $\alpha$ | Pareto shape | – | 2.5 (must be > 1) | Own choice |
| $x_m$ | Pareto scale | ms | $m(\alpha-1)/\alpha$ | Calibrated to mean $m$ |
| $E$ | Slow-node extra delay per message | ms | $\mathrm{Exp}(s)$ | A11 |
| $W$ | Slow-leader heartbeat wait (A14 mode) | ms | $\mathrm{Exp}(s)$ | A14 |
| $s$ | Mean slow extra delay | ms | 150 (§6.1–6.2), 300 (§6.3 sweep); 150–2400 scanned | Placeholder, no source |
| $\Delta$ | Health-chain step | ms | 1000 | Own choice (A5) |
| $P$ | Health transition matrix | – | See §3.5 | Illustrative |
| $\pi$ | Stationary distribution | – | (0.8633, 0.1007, 0.0360) | Computed from $P$ |
| $w$ | Slow-leader weight in downtime | – | 0.5 (swept 0, 0.5, 1) | Own choice (A13) |
| $L$ | Simulated run length | ms | 60 000 (checks), 600 000 (main), 120 000 / 180 000 (extensions) | – |
| $G$ | Gap between two heartbeat arrivals | ms | – | §3.7 |
| $\tau$ | Gap threshold asked about | ms | ≥ $h$ | §3.7 |
| $N$, $n$ | Number of replications | – | 30 (main), 15 (extensions), 10–80 (§6.4) | – |
| – | Master random seed | – | 42 | – |

---

## 4. Numerical method

### 4.1 Discrete-event simulation (next-event time advance)

The model is a **discrete-event simulation (DES)** [4]. The state of the cluster (roles, terms, votes, health) only changes at specific moments called **events**: a heartbeat is sent or arrives, a timer fires, a vote request or reply arrives, or a health step happens. Between events nothing changes, so nothing needs to be computed there.

The algorithm:

1. Keep a **future event list (FEL)**: a priority queue (a binary heap) of entries `(time, seq, kind, data)`, ordered by `time`.
2. Remove the earliest event and **jump the simulation clock** straight to its time.
3. Run that event's handler. The handler updates the state and may schedule new events (for example, a heartbeat send schedules four heartbeat arrivals).
4. Repeat until the FEL is empty or the next event is after the end time $L$.

**Tie-breaking.** `seq` is a counter that increases with every scheduled event. Two events at the same time run in the order they were scheduled, so runs are deterministic.

**Lazy cancellation.** A heap cannot easily delete an event. Instead, each node has a **timer version number**. Resetting the timer increments the version and schedules a new `timeout_fire` with that version. A `timeout_fire` with an old version is stale and is ignored. In the same way, `heartbeat_send` events carry the leader's term and are dropped if the node is no longer leader of that term.

### 4.2 Random number generation

- **Generator:** NumPy random generators, all derived from master seed 42.
- **Separate streams (A12):** `Simulator.stream(purpose, node)` gives one stream per purpose and per node. Two runs with the same seed but a different timeout or jitter therefore share the same health paths and timer draws, and differ only where the model really differs. This is **common random numbers**, which makes comparisons between cells less noisy [4].
- **Variate generation:** continuous inverse transform (exponential, Pareto), transformation of a normal (lognormal), and discrete inverse transform (next health state), as in §3.2 and §3.5.

### 4.3 Accuracy and "time step"

- **No time step.** The clock jumps from event to event, so event times are exact (up to floating-point precision). There is no discretisation error and no stability condition like those in ODE solvers.
- **Downtime is computed exactly.** The meter books the time since the last change every time the working-leader state could change, so equation (7) is summed exactly, not approximated on a grid.
- **The only real error is Monte Carlo (sampling) error,** measured by the confidence intervals of equation (10).

### 4.4 How the sample size was chosen

| Experiment | Replications × run length | Reason |
|---|---|---|
| Main sweep (§6.3): 7 timeouts × 3 jitters × 2 slow modes = 42 cells | 30 × 10 min | 10 minutes contains many slow and failed spells (average Slow stay 16.7 s), and 30 runs give CI half-widths small enough to separate the best timeouts. Total: 475 s of computing. |
| Convergence study (§6.4) | 10, 20, 40, 80 × 2 min | Enough points to estimate the slope of the standard error. |
| Cluster size and delay shape (§6.5) | 15 × 3 min | Kept small to limit run time (see Limitations). |
| Sensitivity analysis (§6.6) | 15 × 3 min | Same reason. |

The convergence study confirms the choice works as theory predicts. The Monte Carlo standard error fell from 2.28 (N = 10) to 0.79 (N = 80), with a fitted log-log slope of **−0.558**, close to the theoretical **−0.5** (equation 10).

---

## 5. Verification

The notebook contains **21 automated checks** (notebook §5). Each uses an `assert` or a tolerance test, so a failure stops the notebook. All 21 pass.

| # | Check | Expected | Obtained | Pass? |
|---|---|---|---|---|
| 1 | Event engine order | Time order; ties in scheduling order; past events rejected | As expected | Yes |
| 2 | Random variates (200 000 draws) | Exponential and lognormal mean 20.00 ms; $P(J > 2m) = e^{-2}$; lognormal median $m e^{-\sigma^2/2}$ | Means 20.05 and 19.97 ms; tail and median within tolerance | Yes |
| 3 | Limiting case: zero jitter, no failures, 60 s | 601 sends, 2400 accepted heartbeats, **0 elections** | 601, 2400, 0 for all 20 seeds | Yes |
| 4 | Negative control: $h = 3000$ ms > max timer 2000 ms | Elections **must** start | 53 elections | Yes |
| 5 | Leader fails at 10 050 ms (zero jitter) | New leader within $[10\,005 + T + 2d,\; 10\,005 + 2T + 2d]$, i.e. 965–1965 ms after failure | 197 single-candidate seeds inside window; 3 split-vote seeds still recovered | Yes |
| 6 | Safety under stress ($T$ = 150 ms, $m$ = 80 ms) | Never two leaders in one term | 0 violations over 1905 elections | Yes |
| 7 | Broken voting rule (vote twice per term) | Safety assertion **must** fire | Fired in 20 of 20 seeds | Yes |
| 8 | Stationary distribution | $\pi P = \pi$, sums to 1, equals hand solution (§3.5) | $\pi$ = (0.8633, 0.1007, 0.0360) | Yes |
| 9 | Chain follows its matrix (20 simulated hours) | Time shares ≈ $\pi$; transition frequencies ≈ $P$ (within 4 SE) | Shares (0.8585, 0.1045, 0.0370); largest transition gap 0.0036 | Yes |
| 10 | Recovery rule (A10) | Recovered leader → follower of old term; follower keeps term and vote | As expected | Yes |
| 11 | Slow rule (A11), $m$ = 20, $s$ = 150 | Mean delay $d + m + s$ = 175 ms (Slow), $d + m$ = 25 ms (Healthy) | 176.1 ms and 25.1 ms | Yes |
| 12 | Separate streams (A12) | Same health path and timer draws across $T$ and jitter | Same 69 health changes; first 301 timer draws match | Yes |
| 13 | Safety with failures and recoveries | Never two leaders in one term | 0 violations over 234 elections and 302 recoveries | Yes |
| 14 | Late-heartbeat mode (A14), $s$ = 150 | Slow-leader gap $h + s$ = 250 ms; healthy exactly 100 ms; $s = 0$ changes nothing | 250 ms; 100 ms; identical runs | Yes |
| 15 | Safety in late-heartbeat mode | Never two leaders in one term | 0 violations over 369 elections, 208 stretched gaps | Yes |
| 16 | Slow-spell finder | Correct outcome on hand-made logs; agrees with raw log | 6 of 6 logs; 40 of 40 forced runs | Yes |
| 17 | False-suspicion formula, equation (9) | $P(G > \tau)$ at 100/150/200/300/400 ms = 0.5000 / 0.1839 / 0.0677 / 0.0092 / 0.0012; formula without ½ rejected | 0.4997 / 0.1837 / 0.0670 / 0.0094 / 0.0013 (236 000 pairs); without ½ rejected | Yes |
| 18 | Downtime meter limiting cases | Healthy run: 0 s downtime. Failed leader: one outage = wait for next leader. Always-slow leader: 0 / 30 / 60 s for $w$ = 0 / 0.5 / 1 | As expected, plus 7 hand-built working-leader situations | Yes |
| 19 | Meter vs independent replay (5 ms grid) | Agree within grid error | Agree over 10 runs, 2262 state changes, 1085 outages | Yes |
| 20 | Confidence intervals | Coverage ≈ 95%; half-width ratio per 4× runs ≈ $t/\sqrt{n}$ prediction (2.24, 2.05, 2.01); determinism | 94.9% coverage (92.8% for skewed data); ratios 2.23, 2.03, 2.01 | Yes |
| 21 | Pareto generator | Mean 20 ms; 99.9th percentile above exponential's; $\alpha \le 1$ rejected | Mean 20.02 ms; 192.1 ms vs 137.1 ms; rejected | Yes |
| – | Monte Carlo convergence (§6.4) | Standard-error slope ≈ −0.5 on log-log axes | −0.558 | Yes (diagnostic) |

**Types of check used:**

- **Analytic comparison:** 2, 5, 8, 11, 14, 17, 21 (the simulation matches a formula worked out by hand).
- **Limiting cases:** 3, 18 (extreme settings with a known answer).
- **Negative controls:** 4, 7, and the rejected formula in 17 (show a check *can* fail, so a pass is meaningful).
- **Invariant (safety):** 6, 13, 15.
- **Independent re-computation:** 16, 19.
- **Statistical method checks:** 9, 20 and the convergence study.

---

## 6. Concepts applied

| Concept | Where it is used in this project |
|---|---|
| Discrete-event simulation (next-event time advance) | Event engine with a heap-based future event list, tie-break counter and lazy cancellation (notebook §4.2, §4.4); checked by checks 1, 3, 4 |
| Input modelling and random variate generation | Inverse transform for exponential and Pareto jitter and slow delay; lognormal from a normal; discrete inverse transform for health states (§4.2, §4.3); checked by checks 2, 11, 21 |
| Discrete-time Markov chains | Healthy / slow / failed chain per node, stationary distribution $\pi$, average stay $1/(1-P_{ii})$ (§4.3); checked by checks 8, 9 |
| Monte Carlo method and the law of large numbers | 30 independent replications per cell, means with 95% t intervals, $1/\sqrt{N}$ error convergence (§4.6, §6.3, §6.4); checked by check 20 |
| Common random numbers (variance reduction) | Separate random stream per purpose and per node (A12); checked by check 12 |
| Statistical comparison of alternatives | Welch intervals to find timeouts tied with the best; Wilson intervals for spell shares (§6.2, §6.3) |
| Sensitivity analysis | Slow weight $w$ recomputed for 0 / 0.5 / 1 (§6.3); one-factor-at-a-time study of $T$, $m$, $s$, $w$ (§6.6) |
| Verification and validation | 21 automated checks, limiting cases, negative controls, independent replay (§5); comparison with etcd tuning guidance [3] (§7.3, §7.5) |

---

## 7. References

See [REFERENCES.md](REFERENCES.md). Numbers in square brackets in this document refer to:

1. D. Ongaro and J. Ousterhout, "In search of an understandable consensus algorithm," in *Proc. USENIX Annual Technical Conference*, 2014.
2. etcd documentation, "Configuration flags" (v3.3).
3. etcd documentation, "Tuning" (v3.5).
4. A. M. Law, *Simulation Modeling and Analysis*, 5th ed. New York, NY, USA: McGraw-Hill, 2015.
