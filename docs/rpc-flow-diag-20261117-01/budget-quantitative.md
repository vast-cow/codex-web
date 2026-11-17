# Multi-client budget measurements

Two clients, two concurrent streams each, except the deliberate admission probes. Every profile has two balanced A/B pairs in each policy. Observe records violations without stopping; stop uses the separate opt-in safeguard. `budget-stop` is a successful stop test and a failed resource-acceptance result. All values below are maxima across the two replicates unless labeled median. Exact bytes, per-connection/stream maxima, ACK percentiles and final GC memory are in [CSV](budget-metrics.csv); [numeric records](budget-results.jsonl) include phase snapshots.

| Profile         | Mode | Policy  | Complete / stopped | Window MiB | Flight total MiB | Decoded total MiB | Forward total MiB | Group RSS MiB | Host heap MiB | Renderer heap MiB |
| --------------- | ---- | ------- | -----------------: | ---------: | ---------------: | ----------------: | ----------------: | ------------: | ------------: | ----------------: |
| mixed-variable  | A    | observe |              2 / 0 |      0.500 |            2.475 |             0.618 |             0.825 |        1433.5 |          51.0 |              4.24 |
| mixed-variable  | B    | observe |              2 / 0 |      0.500 |            2.475 |             0.618 |             0.825 |        1428.7 |          50.8 |              4.13 |
| mixed-variable  | A    | stop    |              2 / 0 |      0.500 |            2.475 |             0.618 |             0.825 |        1432.5 |          50.7 |              4.13 |
| mixed-variable  | B    | stop    |              2 / 0 |      0.500 |            2.475 |             0.618 |             0.825 |        1428.8 |          51.1 |              4.13 |
| variable        | A    | observe |              2 / 0 |      0.489 |            2.002 |             0.500 |             0.667 |        1432.8 |          51.2 |              4.12 |
| variable        | B    | observe |              2 / 0 |      0.500 |            2.002 |             0.500 |             0.667 |        1436.6 |          51.4 |              4.17 |
| variable        | A    | stop    |              2 / 0 |      0.489 |            2.002 |             0.500 |             0.667 |        1433.4 |          51.2 |              4.12 |
| variable        | B    | stop    |              2 / 0 |      0.500 |            2.002 |             0.500 |             0.667 |        1444.2 |          51.2 |              4.16 |
| bandwidth       | A    | observe |              2 / 0 |      0.500 |            2.002 |             0.500 |             0.667 |        1434.8 |          50.3 |              4.12 |
| bandwidth       | B    | observe |              2 / 0 |      0.500 |            2.002 |             0.500 |             0.667 |        1433.6 |          50.3 |              4.12 |
| bandwidth       | A    | stop    |              2 / 0 |      0.499 |            2.002 |             0.500 |             0.667 |        1435.7 |          50.2 |              4.12 |
| bandwidth       | B    | stop    |              2 / 0 |      0.500 |            2.002 |             0.500 |             0.667 |        1436.4 |          50.1 |              4.12 |
| slow            | A    | observe |              2 / 0 |      0.558 |            3.003 |             0.750 |             0.667 |        1439.4 |          51.2 |              4.14 |
| slow            | B    | observe |              2 / 0 |      0.537 |            3.003 |             0.750 |             0.667 |        1441.5 |          51.4 |              4.14 |
| slow            | A    | stop    |              2 / 0 |      0.543 |            3.003 |             0.750 |             0.667 |        1434.6 |          51.2 |              4.14 |
| slow            | B    | stop    |              2 / 0 |      0.544 |            3.003 |             0.750 |             0.667 |        1442.0 |          51.2 |              4.14 |
| stall           | A    | observe |              2 / 0 |      1.290 |            4.504 |             1.062 |             1.334 |        1444.7 |          51.0 |              4.19 |
| stall           | B    | observe |              2 / 0 |      1.313 |            4.254 |             1.000 |             1.251 |        1446.1 |          50.7 |              4.22 |
| stall           | A    | stop    |              0 / 2 |      0.772 |            3.253 |             0.750 |             0.834 |        1424.3 |          49.3 |              4.06 |
| stall           | B    | stop    |              0 / 2 |      0.774 |            3.253 |             0.750 |             0.834 |        1425.2 |          49.1 |              4.23 |
| cancel          | A    | observe |              2 / 0 |      1.354 |            3.003 |             0.750 |             0.917 |        1427.9 |          51.1 |              4.12 |
| cancel          | B    | observe |              2 / 0 |      1.341 |            3.003 |             0.750 |             0.917 |        1427.7 |          50.9 |              4.12 |
| cancel          | A    | stop    |              1 / 1 |      1.352 |            3.003 |             0.750 |             0.834 |        1429.8 |          51.0 |              4.22 |
| cancel          | B    | stop    |              0 / 2 |      0.767 |            3.003 |             0.750 |             0.834 |        1420.5 |          48.1 |              4.22 |
| disconnect      | A    | observe |              2 / 0 |      0.775 |            3.503 |             0.812 |             1.001 |        1425.8 |          51.3 |              4.02 |
| disconnect      | B    | observe |              2 / 0 |      0.773 |            3.503 |             0.812 |             1.001 |        1423.5 |          51.1 |              4.03 |
| disconnect      | A    | stop    |              0 / 2 |      0.772 |            3.253 |             0.750 |             0.834 |        1423.5 |          48.8 |              4.13 |
| disconnect      | B    | stop    |              0 / 2 |      0.766 |            3.253 |             0.750 |             0.834 |        1427.6 |          48.8 |              4.13 |
| peer-stop-probe | A    | observe |              2 / 0 |      0.711 |            2.002 |             0.500 |             0.667 |        1426.5 |          50.3 |              4.08 |
| peer-stop-probe | B    | observe |              2 / 0 |      0.716 |            2.002 |             0.500 |             0.667 |        1419.8 |          50.3 |              4.08 |
| peer-stop-probe | A    | stop    |              0 / 2 |      0.000 |            0.000 |             0.000 |             0.000 |        1383.9 |          40.2 |              1.91 |
| peer-stop-probe | B    | stop    |              0 / 2 |      0.000 |            0.000 |             0.000 |             0.000 |        1389.6 |          40.3 |              1.91 |
| recovery-soak   | A    | observe |              2 / 0 |      0.991 |            4.004 |             1.000 |             1.251 |        1441.7 |          51.8 |              4.14 |
| recovery-soak   | B    | observe |              2 / 0 |      1.000 |            4.004 |             1.000 |             1.251 |        1447.5 |          51.4 |              4.15 |
| recovery-soak   | A    | stop    |              0 / 2 |      0.779 |            3.253 |             0.750 |             0.834 |        1437.8 |          50.1 |              3.88 |
| recovery-soak   | B    | stop    |              0 / 2 |      0.760 |            3.253 |             0.750 |             0.834 |        1432.9 |          49.6 |              3.88 |
| over-clients    | A    | observe |              2 / 0 |      1.008 |            3.003 |             0.688 |             0.834 |        1431.8 |          50.8 |              4.20 |
| over-clients    | B    | observe |              2 / 0 |      1.003 |            3.003 |             0.750 |             0.834 |        1426.3 |          50.1 |              4.20 |
| over-clients    | A    | stop    |              0 / 2 |      0.250 |            1.001 |             0.250 |             0.334 |        1386.3 |          42.6 |              1.96 |
| over-clients    | B    | stop    |              0 / 2 |      0.250 |            1.001 |             0.250 |             0.334 |        1381.3 |          42.6 |              1.96 |
| over-streams    | A    | observe |              2 / 0 |      0.760 |            4.004 |             0.938 |             1.251 |        1430.3 |          50.7 |              4.11 |
| over-streams    | B    | observe |              2 / 0 |      0.760 |            4.254 |             1.000 |             1.251 |        1426.8 |          50.4 |              3.63 |
| over-streams    | A    | stop    |              0 / 2 |      0.000 |            0.000 |             0.000 |             0.000 |        1388.1 |          40.8 |              1.93 |
| over-streams    | B    | stop    |              0 / 2 |      0.000 |            0.000 |             0.000 |             0.000 |        1389.7 |          40.8 |              1.93 |
| atomic-boundary | A    | observe |              2 / 0 |      0.986 |            3.753 |             0.938 |             1.251 |        1424.1 |          49.4 |              3.69 |
| atomic-boundary | B    | observe |              2 / 0 |      0.954 |            3.753 |             0.938 |             1.251 |        1424.7 |          49.4 |              3.69 |
| atomic-boundary | A    | stop    |              0 / 2 |      0.858 |            2.815 |             0.625 |             0.834 |        1414.9 |          51.2 |              3.68 |
| atomic-boundary | B    | stop    |              0 / 2 |      0.844 |            2.815 |             0.625 |             0.834 |        1405.5 |          50.9 |              3.68 |
| netem-bandwidth | A    | observe |              2 / 0 |      0.523 |            2.502 |             0.625 |             0.945 |        1424.7 |          50.8 |              4.12 |
| netem-bandwidth | B    | observe |              2 / 0 |      0.606 |            2.502 |             0.625 |             0.947 |        1430.6 |          51.0 |              4.12 |
| netem-bandwidth | A    | stop    |              2 / 0 |      0.525 |            2.502 |             0.625 |             0.918 |        1434.9 |          51.1 |              4.12 |
| netem-bandwidth | B    | stop    |              2 / 0 |      0.610 |            2.502 |             0.625 |             0.945 |        1433.7 |          51.1 |              4.12 |
| netem-variable  | A    | observe |              2 / 0 |      0.825 |            3.503 |             0.875 |             1.418 |        1460.3 |          51.8 |              4.21 |
| netem-variable  | B    | observe |              2 / 0 |      0.820 |            3.253 |             0.812 |             1.418 |        1444.9 |          51.5 |              4.22 |
| netem-variable  | A    | stop    |              0 / 2 |      0.959 |            2.252 |             0.500 |             0.751 |        1421.7 |          51.0 |              3.44 |
| netem-variable  | B    | stop    |              0 / 2 |      0.814 |            2.002 |             0.500 |             0.751 |        1421.5 |          51.0 |              4.07 |

Group RSS includes the worker, preparation-free controller, and all Chromium descendants, including browser/zygote/GPU/utility processes. It sums RSS conservatively and can double-count shared pages. Kernel TX is sampled separately and included in the forward ledger when observed. Client receive and reverse queues have separate local caps; their per-client peak sums in the CSV are conservative upper bounds, not simultaneous measured totals.

| Completed profile | Policy  | A MiB/s median | B MiB/s median | Throughput change | Body-time change |
| ----------------- | ------- | -------------: | -------------: | ----------------: | ---------------: |
| mixed-variable    | observe |         2.1008 |         3.1950 |           +52.09% |          -34.25% |
| mixed-variable    | stop    |         2.1029 |         3.1976 |           +52.05% |          -34.23% |
| variable          | observe |         1.6951 |         2.8898 |           +70.49% |          -41.34% |
| variable          | stop    |         1.6967 |         2.8875 |           +70.19% |          -41.24% |
| bandwidth         | observe |         0.3722 |         0.3721 |            -0.02% |           +0.02% |
| bandwidth         | stop    |         0.3721 |         0.3722 |            +0.01% |           -0.01% |
| slow              | observe |         2.3632 |         2.3641 |            +0.04% |           -0.04% |
| slow              | stop    |         2.3637 |         2.3638 |            +0.00% |           -0.00% |
| stall             | observe |         1.7263 |         1.7359 |            +0.56% |           -0.55% |
| cancel            | observe |         2.2924 |         2.2943 |            +0.08% |           -0.08% |
| disconnect        | observe |         1.7760 |         1.7777 |            +0.09% |           -0.09% |
| recovery-soak     | observe |         2.5188 |         2.5243 |            +0.22% |           -0.22% |
| atomic-boundary   | observe |         2.7732 |         2.7733 |            +0.00% |           -0.00% |
| netem-bandwidth   | observe |         0.6193 |         0.6228 |            +0.56% |           -0.56% |
| netem-bandwidth   | stop    |         0.6170 |         0.6211 |            +0.67% |           -0.66% |
| netem-variable    | observe |         1.2968 |         2.0154 |           +55.41% |          -35.65% |

Performance uses actual verified decoded byte counts and source-first-pull to last-consumption notification on the host clock. Canceled/disconnected work is partial verified delivery, not successful full-body throughput. Stopped runs have no performance acceptance claim. Sampling and observation bindings add overhead equally in A/B. These models are not production startup measurements.

| Profile         | Policy  | First violation kinds | Largest first-crossing/rejected forward reservation bytes | Limit bytes |
| --------------- | ------- | --------------------- | --------------------------------------------------------: | ----------: |
| mixed-variable  | observe | none                  |                                                       n/a |      524288 |
| mixed-variable  | stop    | none                  |                                                       n/a |      524288 |
| variable        | observe | none                  |                                                       n/a |      524288 |
| variable        | stop    | none                  |                                                       n/a |      524288 |
| bandwidth       | observe | none                  |                                                       n/a |      524288 |
| bandwidth       | stop    | none                  |                                                       n/a |      524288 |
| slow            | observe | none                  |                                                       n/a |      524288 |
| slow            | stop    | none                  |                                                       n/a |      524288 |
| stall           | observe | transport             |                                                    524592 |      524288 |
| stall           | stop    | transport             |                                                    524592 |      524288 |
| cancel          | observe | transport             |                                                    524592 |      524288 |
| cancel          | stop    | transport             |                                                    524592 |      524288 |
| disconnect      | observe | transport             |                                                    524592 |      524288 |
| disconnect      | stop    | transport             |                                                    524592 |      524288 |
| peer-stop-probe | observe | peerTransport         |                                                       n/a |      524288 |
| peer-stop-probe | stop    | peerTransport         |                                                       n/a |      524288 |
| recovery-soak   | observe | transport             |                                                    524592 |      524288 |
| recovery-soak   | stop    | transport             |                                                    524592 |      524288 |
| over-clients    | observe | clients               |                                                       n/a |      524288 |
| over-clients    | stop    | clients               |                                                       n/a |      524288 |
| over-streams    | observe | streams               |                                                    524592 |      524288 |
| over-streams    | stop    | streams               |                                                       n/a |      524288 |
| atomic-boundary | observe | transport             |                                                    546385 |      524288 |
| atomic-boundary | stop    | transport             |                                                    546385 |      524288 |
| netem-bandwidth | observe | none                  |                                                       n/a |      524288 |
| netem-bandwidth | stop    | none                  |                                                       n/a |      524288 |
| netem-variable  | observe | transport             |                                                    612094 |      524288 |
| netem-variable  | stop    | transport             |                                                    524632 |      524288 |

| Completed action | Variant | Max source-cancel latency ms | Max host credit drain after TCP close ms |
| ---------------- | ------- | ---------------------------: | ---------------------------------------: |
| cancel           | A       |                        82.60 |        n/a (other streams remain active) |
| cancel           | B       |                        83.70 |        n/a (other streams remain active) |
| disconnect       | A       |                         7.84 |                                     1.37 |
| disconnect       | B       |                         8.31 |                                     1.26 |

Actions are marked through the local observation binding before the browser call; source cancellation and TCP/credit hooks use the same host clock. Latencies include that binding overhead. Single-stream cancel leaves other streams active, so connection-wide drain is measured only for disconnect. All final credit waiters and actual extracted-controller outstanding bytes are zero.
