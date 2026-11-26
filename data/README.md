# Data

This project uses **no external data**. There are no downloaded datasets, no measurements from a real Raft or etcd cluster, and no personal data. This folder therefore contains no data files.

All data in the project is **synthetic**: the notebook (`notebook/`) generates it while it runs, using the simulation model described in [THEORY.md](../THEORY.md).

## How the data is generated

| What | How it is produced | Where in the notebook |
|---|---|---|
| Network delays | Random draws: 5 ms fixed part + jitter (constant, exponential, lognormal or Pareto) + an extra delay when the sender is Slow | §4.2 |
| Election timer lengths | Random draws from Uniform[T, 2T] | §4.4 |
| Node health (healthy / slow / failed) | Each node's own discrete-time Markov chain, stepped every 1 s | §4.3 |
| Event logs (heartbeats, elections, leaders, health changes) | Recorded by the discrete-event simulation during each run | §4.4, §4.5 |
| Results (downtime, elections, outage lengths) | Computed from each run by the downtime meter, then averaged over replications with 95% confidence intervals | §4.6, §6 |

## Reproducibility

- Every random number comes from **master seed 42**, with a separate random stream for each purpose and each node.
- Running the notebook top to bottom (Runtime → Run all) gives **identical numbers** on any machine. Only the wall-clock time differs.
- Nothing is saved to disk. To get the data again, re-run the notebook.

## Parameter values

Parameter values that are not taken from etcd defaults (the health transition matrix, the slow extra delay, the jitter levels and the slow weight) are **illustrative assumptions**, not measurements. They are listed with their sources in the symbol table in [THEORY.md](../THEORY.md) §3.9.
