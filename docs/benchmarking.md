# Listener load benchmarking

Run commands from the repository root. For deployment, see [the deployment guide](../infra/README.md).

Use Python 3.11+ from a different machine to test your own public station through its
HTTPS reverse proxy. Each simulated listener consumes the continuous Ogg/Opus audio
stream and live metadata over two HTTP/1.1 connections. It checks live Ogg page sequence
continuity, stream stalls, health response times, host resources, and process open files.
It does not simulate browser rendering, the equalizer, initial asset downloads, or HTTP/2.

```sh
python3 scripts/test-benchmark-listeners.py
python3 scripts/benchmark-listeners.py \
  --url https://your-radio.example \
  --ssh-target ubuntu@your-vps --ssh-port 22 --sudo-metrics \
  --output /tmp/radio-benchmark-1
```

The read-only Linux collector watches `station-station-1` and `caddy-proxy-caddy-1`.
`--sudo-metrics` uses existing passwordless sudo to read their process FD counts;
without it, those counts must already be readable. The test stops if telemetry is missing.
The station must be public and on air; simulated listeners temporarily appear in its count.

Defaults ramp through 1, 10, 25, 50, 100, 200, 400, 600, 800, and 1,000 listeners,
holding intermediate stages for 25 seconds and the final stage for 120 seconds. Joins
slow from 20/s to 5/s after 300 listeners. The test closes its connections on completion
or interruption, with a 4 GiB received-body traffic cap and 12-minute time cap. It stops
at 90% of either process's open-file limit, three samples of host CPU above 85% or
available memory below 1 GiB, any stream error or audio-page gap, repeated health
failures, or a saturated load generator. A passed stage is a measured result for its hold
duration, not a guaranteed maximum; use `--stages 400 --final-hold 120` to confirm a
lower stage after the ramp stops. Output includes raw JSONL metrics, a summary, and
a bounded audio sentinel that can be independently checked with ffmpeg:

```sh
ffmpeg -v warning -i /tmp/radio-benchmark-1/sentinel.ogg -f null -
```

For a planned 1,000-listener hold, add `--max-gib 8` to explicitly allow a larger
transfer budget. The default remains 4 GiB and the maximum accepted budget is 8 GiB;
the 1,000-listener, 20 joins/second, 12-minute, and resource limits still apply.
Each join currently broadcasts a full metadata snapshot to existing listeners, so
cumulative join metadata traffic grows approximately as O(N²). A ramp can therefore
use substantially more bandwidth than steady audio delivery. Passing the requested
hold measures that run's conditions and duration; it does not establish a hardware maximum.

Listener summaries and stage results include the largest audio delivery gap's elapsed
time, phase (`ramp` or `hold`), and target listener count. The elapsed time marks the
arrival that ends the gap; subtract its duration to check whether it crossed a phase
boundary. These maxima remain cumulative across stages, without per-listener log events.

For larger external tests, the separate coordinator uses five worker processes,
each with up to 1,000 listeners. One coordinator collects server metrics and controls
the **global** new-listener rate, so five workers do not multiply that rate:

```sh
python3 scripts/test-radio-load-worker.py
python3 scripts/test-benchmark-radio-scale.py
python3 scripts/benchmark-radio-scale.py \
  --url https://your-radio.example \
  --ssh-target ubuntu@your-vps --ssh-port 22 --sudo-metrics \
  --stages 1000,2000,3000,4000,5000 --output /tmp/radio-scale-1
```

This mode continues after isolated failures, records five-second audio stalls, and
recovers individual connections after longer stalls or protocol failures. It records
actual connected, currently healthy, and continuously healthy listeners separately;
allocated listener slots alone are not a listener-count result. Ogg granule progress
measures media lag as well as byte arrival. A hold passes only if at least 99% of
the requested count remains connected and continuously healthy in its samples. The
raw failure counts remain part of the result; a pass does not imply zero errors.

The default global join ceiling is 20/s, with adaptive reductions or pauses when CPU,
worker load, or delivery health deteriorates. Server resource guards remain active.
Over 5% unhealthy slots for 60 seconds, stale worker/server telemetry, or a saturated
worker also stop the test. Workers close their connections on control-channel loss
or a missing coordinator heartbeat. The larger mode defaults to a **60 GiB** received
traffic budget and **30 minutes**, including a two-minute final hold. These are
explicit larger-test budgets: 5,000 streams require roughly 500 Mbps for audio alone,
and join-triggered metadata fan-out can add substantial traffic. Record limits of the
external load source before attributing any result to server capacity.

For native local stream-load tests, `h2load` (nghttp2) can multiplex many ongoing
audio requests over a smaller number of HTTP/2 connections. For example, 50 sessions
with 100 streams each and 20 requests/s/session target a 5,000-stream fill at 1,000/s:

```sh
h2load --alpn-list=h2 -t4 -c50 -m100 --rps=20 -D35s -w14 -W20 \
  'https://your-radio.example/stream?burst=1000'
```

These are audio-stream connections, rather than complete listener-page clients.
Confirm actual counts through `/api/station` and monitor host memory, FD usage, and
CPU during the run. Configured streams and started requests are not accepted listeners.
For infinite response bodies, zero completed/succeeded requests is expected; HTTP
status counts and received data are separate observations. The supplied
`h2load-radio-helpers.py` and its tests calculate cohorts up to a 15,000-stream
cap and parse native summaries. HTTP/2 reduces frontend TCP use; the current proxy
still needs separate backend sockets for ongoing requests. Small flow-control windows
bound buffering but do not establish real-time delivery for every stream.

The Python coordinator also supports explicit steady-load diagnostics:
`--defer-metadata --stages 5000` connects audio first and attaches metadata before
the hold, excluding the ordinary join fan-out pattern. In this mode, `--rate` may
be raised explicitly to 200/s and `--metadata-rate` to 200/s. Resource guards remain
active. `--worker-uvloop` uses an explicitly installed optional uvloop dependency
in the worker interpreter; the standard library remains the default. A
`--remote-worker-dir` with a loopback `--worker-url` runs clients on the SSH target,
so that diagnostic measures backend delivery and includes load-generator CPU on
the host, rather than measuring public HTTPS capacity from an external machine.
