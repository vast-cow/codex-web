# Measured resource comparison

Each row gives the maximum across two identical-condition replicates. A = baseline; B = 512k. Memory peaks are sampled at 20 ms; WebSocket API buffering is also observed immediately after sends. Quantities in separate columns need not peak simultaneously. Exact byte values, both replicates, ACK percentiles, and post-GC memory are in [CSV](guard-metrics.csv) and [raw numeric records](guard-results.jsonl).

| Scenario     | Variant | Window MiB | Est. flight MiB | WS bytes (host/browser) | Shaper JSON KiB | Writer decoded KiB | Pipeline decoded bound KiB | >1 MiB total / longest ms | Tail drain ms |
| ------------ | ------- | ---------: | --------------: | ----------------------: | --------------: | -----------------: | -------------------------: | ------------------------: | ------------: |
| loop-0-0     | A       |      1.017 |           1.251 |                    0/36 |           341.5 |                192 |                        384 |               25.5 / 10.3 |           9.9 |
| loop-0-0     | B       |      0.965 |           1.001 |                    0/36 |           256.1 |                192 |                        320 |               35.3 / 11.2 |          15.4 |
| loop-40-3    | A       |      3.705 |           2.252 |                    0/56 |           256.1 |                256 |                        256 |             169.9 / 117.9 |          58.8 |
| loop-40-3    | B       |      3.462 |           2.252 |                    0/56 |           256.1 |                256 |                        256 |             170.2 / 119.4 |          58.5 |
| loop-100-30  | A       |      1.611 |           1.752 |                    0/56 |           170.8 |                256 |                        320 |             544.2 / 473.2 |         229.4 |
| loop-100-30  | B       |      1.616 |           1.752 |                    0/56 |           170.8 |                256 |                        320 |             550.2 / 480.1 |         232.3 |
| wan-stable   | A       |      1.532 |           1.752 |                    0/46 |           597.7 |                 64 |                        448 |           2409.1 / 1707.7 |         165.3 |
| wan-stable   | B       |      1.523 |           1.752 |                    0/46 |           512.3 |                 64 |                        448 |           2324.2 / 1627.8 |         165.7 |
| wan-variable | A       |      0.820 |           1.001 |                    0/46 |           341.5 |                 64 |                        256 |             165.9 / 165.9 |         174.8 |
| wan-variable | B       |      0.814 |           1.001 |                    0/46 |           341.5 |                 64 |                        256 |             163.8 / 163.8 |         174.7 |
| bandwidth    | A       |      0.628 |           0.751 |                    0/56 |           256.1 |                 64 |                        192 |                 0.0 / 0.0 |         667.0 |
| bandwidth    | B       |      0.627 |           0.751 |                    0/56 |           256.1 |                 64 |                        192 |                 0.0 / 0.0 |         666.5 |
| slow         | A       |      0.513 |           0.751 |                    0/56 |           170.8 |                128 |                        192 |                 0.0 / 0.0 |         206.1 |
| slow         | B       |      0.519 |           0.751 |                    0/56 |           170.8 |                128 |                        192 |                 0.0 / 0.0 |         205.8 |
| stall-resume | A       |      2.304 |           2.502 |                    0/46 |           853.8 |                384 |                        640 |           4160.8 / 4079.5 |         288.5 |
| stall-resume | B       |      2.303 |           2.502 |                    0/46 |           853.8 |                384 |                        640 |           4162.1 / 4083.6 |         290.8 |
| stall-8s     | A       |      2.267 |           2.502 |                    0/46 |           768.4 |                384 |                        640 |         10164.3 / 10085.7 |         206.1 |
| stall-8s     | B       |      2.310 |           2.502 |                    0/46 |           768.4 |                384 |                        640 |         10163.9 / 10083.1 |         289.8 |
| disconnect   | A       |      1.290 |           1.501 |                    0/46 |           512.3 |                384 |                        384 |           2431.2 / 2351.0 |     see below |
| disconnect   | B       |      1.290 |           1.501 |                    0/46 |           512.3 |                384 |                        384 |           2433.3 / 2352.1 |     see below |

Tail drain = last decoded source pull to final write ACK on the host clock. It includes draining the remaining bounded network/writer work, not forced cleanup. Pipeline bound conservatively counts produced decoded bytes minus consumption reported through the local observation binding; encoded copies and delayed observation can overcount physically resident decoded data. Shaper and writer columns measure their own retained data.

| Scenario     | Variant | Host RSS / heap peak MiB | Renderer RSS / heap peak MiB | Host / renderer RSS growth MiB | Host / renderer heap after GC MiB |
| ------------ | ------- | -----------------------: | ---------------------------: | -----------------------------: | --------------------------------: |
| loop-0-0     | A       |           133.55 / 49.57 |                338.94 / 2.06 |                   8.50 / 18.81 |                      37.04 / 1.08 |
| loop-0-0     | B       |           133.00 / 49.10 |                344.35 / 1.83 |                   9.12 / 26.05 |                      37.04 / 1.08 |
| loop-40-3    | A       |           134.14 / 49.00 |                344.67 / 2.06 |                   9.38 / 21.06 |                      37.04 / 1.08 |
| loop-40-3    | B       |           133.59 / 50.30 |                344.53 / 2.06 |                   9.00 / 23.14 |                      37.04 / 1.08 |
| loop-100-30  | A       |           134.73 / 50.18 |                344.57 / 2.07 |                   9.62 / 22.21 |                      37.04 / 1.08 |
| loop-100-30  | B       |           135.22 / 50.34 |                345.24 / 2.07 |                  10.62 / 21.89 |                      37.04 / 1.08 |
| wan-stable   | A       |           141.98 / 50.69 |                345.61 / 3.06 |                  17.00 / 24.10 |                      37.05 / 1.08 |
| wan-stable   | B       |           142.60 / 50.77 |                345.86 / 3.07 |                  18.00 / 23.68 |                      37.05 / 1.08 |
| wan-variable | A       |           142.74 / 50.37 |                347.66 / 3.06 |                  18.38 / 24.86 |                      37.00 / 1.08 |
| wan-variable | B       |           142.19 / 50.56 |                346.96 / 3.06 |                  17.38 / 24.28 |                      37.07 / 1.08 |
| bandwidth    | A       |           141.36 / 49.67 |                340.45 / 2.04 |                  16.75 / 19.88 |                      37.08 / 1.08 |
| bandwidth    | B       |           142.19 / 49.83 |                344.01 / 2.04 |                  17.25 / 22.76 |                      37.08 / 1.08 |
| slow         | A       |           142.66 / 50.50 |                345.41 / 3.16 |                  18.12 / 29.26 |                      37.09 / 1.08 |
| slow         | B       |           143.01 / 50.26 |                346.93 / 3.07 |                  18.62 / 23.35 |                      37.09 / 1.08 |
| stall-resume | A       |           142.63 / 51.03 |                345.75 / 3.08 |                  17.75 / 25.05 |                      37.13 / 1.09 |
| stall-resume | B       |           142.10 / 51.08 |                347.43 / 3.10 |                  17.50 / 24.95 |                      37.09 / 1.09 |
| stall-8s     | A       |           142.48 / 51.01 |                341.54 / 3.12 |                  17.75 / 22.77 |                      37.18 / 1.09 |
| stall-8s     | B       |           142.62 / 50.91 |                352.74 / 3.08 |                  17.75 / 24.08 |                      37.18 / 1.09 |
| disconnect   | A       |           138.13 / 50.56 |                344.10 / 2.06 |                  13.75 / 22.27 |                      37.04 / 1.08 |
| disconnect   | B       |           137.83 / 50.93 |                348.44 / 1.98 |                  13.00 / 22.07 |                      37.03 / 1.08 |

| Scenario     | A MiB/s (median) | B MiB/s (median) | B throughput change | Body-time change |
| ------------ | ---------------: | ---------------: | ------------------: | ---------------: |
| loop-0-0     |           3.5933 |           3.4981 |              -2.65% |           +2.77% |
| loop-40-3    |           2.0759 |           2.0702 |              -0.28% |           +0.28% |
| loop-100-30  |           0.9530 |           0.9488 |              -0.43% |           +0.44% |
| wan-stable   |           1.3644 |           1.3631 |              -0.09% |           +0.09% |
| wan-variable |           0.5314 |           0.8155 |             +53.46% |          -34.84% |
| bandwidth    |           0.1824 |           0.1824 |              +0.01% |           -0.01% |
| slow         |           0.6084 |           0.6088 |              +0.08% |           -0.08% |
| stall-resume |           0.8541 |           0.8539 |              -0.02% |           +0.02% |
| stall-8s     |           0.3744 |           0.3743 |              -0.01% |           +0.01% |

Throughput uses source first decoded pull to the final browser-consumption notification on the host clock, including configured stalls. The observation binding adds local overhead equally in A/B. These are modeled-path results, not production predictions.

| Scenario     | Variant | Source cancels after disconnect ms | Host credit/flight clears ms | Browser read rejects ms | Backlog clears after resume ms |
| ------------ | ------- | ---------------------------------: | ---------------------------: | ----------------------: | -----------------------------: |
| stall-resume | A       |                                n/a |                          n/a |                     n/a |                          11.60 |
| stall-resume | B       |                                n/a |                          n/a |                     n/a |                          11.90 |
| stall-8s     | A       |                                n/a |                          n/a |                     n/a |                          12.60 |
| stall-8s     | B       |                                n/a |                          n/a |                     n/a |                          12.60 |
| disconnect   | A       |                               1.53 |                         0.89 |                    2.70 |                            n/a |
| disconnect   | B       |                               1.54 |                         0.91 |                    2.60 |                            n/a |
