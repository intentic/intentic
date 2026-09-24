# Why the sandbox does not feel local

**The quick fixes are in.** The diagnosis below is kept as written; what was built, and what it measures now, is at
the end, in "What was done".

Measured on 2026-09-22 on `rog`, the owner's own machine: WSL2 on a 16-core Core Ultra 9 275HX, 20 GB of RAM,
`vm.swappiness=150`, a 16 GB container limit. Seven agents were working in the sandbox throughout, which is an
ordinary day here. Every figure below comes from one of three sources: the daemon's own telemetry under
`/history/logs`, a five-minute CPU profile of the live daemon, or a reproduction that ran the daemon's installed
code (`/opt/sandbox/dist` and `@intentic/sandbox-contract`'s `ingress-protocol.js`). None of it comes from reading
code alone.

## The headline

The daemon's single event loop is what makes the sandbox feel remote, ahead of the network and the disk. The loop
is busy 56% of the time and regularly stops for whole seconds, and every terminal keystroke, stream frame and file
read waits behind it.

1. **A busy daemon pushes the browser off the fast lane.** From Windows on `rog`, this sandbox's loopback listener
   answers `/health` in 0.5–1.1 ms, and the tunnel takes 157–197 ms. When a daemon freeze makes a loopback
   request hit the 45 s deadline, the editor treats it as a broken network path and switches to the tunnel for
   1 to 30 minutes.
2. **The event loop freezes often.** Over five days of per-minute samples, the worst event-loop delay in a minute
   was 126 ms at the median, 1.1 s at p90, 6.5 s at p99 and 31.8 s at worst. 434 minutes held a freeze longer
   than 2 s. Only 21 of those fell on an idle machine, where the host sleeping is the likelier cause. In 27 hours
   the browser logged 11,829 daemon requests that took 1.5 s or more, and 131 that ran into its 45 s deadline.
3. **The profile names the code behind the freezes.** It caught 13 runs of more than 1 s in five minutes, each a
   piece of daemon code doing synchronous work on the main thread: a per-minute metric that walks 81 million
   characters of path strings (2.9 s), attributing changed files to agents on every `/git/changes` call
   (1.1–1.5 s), synchronous SQLite (1.3 s), syntax tokenizing to count lines of code (1.4 s) and a whole-file
   UTF-8 decode (2.0 s). Separately, walking the whole workspace tree again and again cost 25 s of CPU in those
   five minutes.
4. **Swap makes it worse.** The daemon keeps a 0.5–2 GB heap on a machine that swaps readily, and 400–800 MB of
   that heap is swapped out. In minutes where the daemon itself took at least 100k major page faults, 71% had a
   freeze over 1.5 s. Under 1k faults, 3% did.
5. **The tunnel is capped at 64 KB per round trip.** The HTTP/2 session inside the tunnel sets a 1 MB window per
   stream but leaves the connection-level window at the protocol default of 65,535 bytes. Every stream (downloads,
   uploads, terminals, events) shares that 64 KB. At 50 ms RTT, a 100 Mbit/s link carries about 1.1 MB/s, and a
   small request waits one or two extra round trips behind any transfer.
6. **A tunnel that dies silently is not redialled.** The daemon's side of the tunnel sends no pings. After a host
   sleep or a network change, it keeps waiting on a socket that will not receive anything again.

## 1. The event loop

### What the telemetry says

`resource-metrics.jsonl`: 7,479 samples, one per minute, 2026-09-17 to 2026-09-22.

| Per minute | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| Worst event-loop delay | 126 ms | 1.1 s | 6.5 s | 31.8 s |
| Longest GC pause | 15 ms | 37 ms | 1.0 s | 10.2 s |
| Daemon heap used | 558 MB | 856 MB | 1.8 GB | 2.0 GB |
| Daemon memory in swap | 163 MB | 371 MB | 791 MB | 2.2 GB |
| fs requests in flight on the 4-thread libuv pool | 0 | 3 | 319 | 6,951 |
| Machine load average (16 cores) | 1.6 | 15.7 | 62.7 | 117.6 |

The loop watchdog (`loop-watchdog.ts`) recorded 90 stalls over 1.5 s since 2026-09-21 19:00, of two kinds.

- CPU-bound: daytime stalls of 1.5–4.2 s in which the daemon burned as much CPU as the stall lasted or more
  (ratio 1.0–1.3), with quiet pressure stall information (PSI). This is the daemon's own synchronous work.
- Blocked in the kernel: the process used almost no CPU (ratio 0.03–0.1). The overnight ones repeat almost
  exactly hourly with zero PSI, which looks like the host sleeping rather than the daemon. The daytime ones match
  swap-in, as the next table shows.

Swap, correlated against the daemon's own major page faults (`process.resourceUsage()`):

| Daemon major faults in the minute | Minutes | P(freeze > 1.5 s) | P(freeze > 5 s) | Median daemon swap |
| --- | --- | --- | --- | --- |
| < 1k | 5,351 | 3.0% | 0.2% | 135 MB |
| 1k–10k | 1,300 | 10.3% | 0.8% | 199 MB |
| 10k–100k | 758 | 28.6% | 7.7% | 320 MB |
| ≥ 100k | 91 | 71.4% | 26.4% | 504 MB |

The pressure comes from outside the container. At measurement time the WSL VM (20 GB) had 1.5 GB free and 10.4 GB
in swap. The container itself was at 11.6 GB, below its own `memory.high` of 14.7 GB, so this is global reclaim,
and the container's `memory.high` does not protect the daemon from it. Since boot, the container has taken 21.6 M
major faults and 25 M refaults of swapped-out anonymous pages. A fresh test process on this machine could not keep
900 MB resident long enough to measure. The kernel had swapped most of it out within seconds.

A 4-minute sample of the main thread's scheduler state (`/proc/7/task/7/stat` every 10 ms, against a `/health`
probe every 200 ms) confirmed both kinds live. The worst stall was 2.56 s with the thread running 98% of the
time. A 389 ms stall had the thread in uninterruptible sleep 49% of the time, taking 2,338 major faults.

### What the profile says

Sampling profile of PID 7, 20:44:48–20:49:48 UTC, 1 ms interval, taken through the inspector (SIGUSR1) and closed
afterwards. The main thread spent 45.9% of the time in JavaScript, 5.3% in GC, 5.2% in "(program)" and 43.6% idle.

The longest single freezes:

| Freeze | Where | What it is doing |
| --- | --- | --- |
| 2,878 ms | `pathWeight`, `agents/registry/expiry.ts`, called from the per-minute resource sample | Adds up the length of every path string in every set the expiry tracker holds (81.8 M characters) to report one number. It ran five times in the profile: once for 2.6 s, four times for about 0.2 s each. The long run is consistent with that memory having been swapped out. |
| 1,985 ms | `decode` inside `fs.promises.readFile(…, "utf8")` | A whole file decoded on the main thread. The caller is not on the stack, because it resumes from the fs thread pool. `transcript-record.ts` reads whole records this way. |
| 1,547 / 1,192 / 1,091 ms | `forRepo`, `agents/land/origins.ts`, for `/git/changes` | Walks all 2,774 registry entries, then builds a fresh `Set` of paths for every unabsorbed landing (the caches track 293), on every call. |
| 1,542 ms | Garbage collector (1,423 ms of it) | A major collection. |
| 1,360 / 1,291 ms | Shiki's `findNextMatchSync` under `@intentic/code-read` `walkTokens`, whose only importer in the daemon is `git/changes/code-counts.ts` | Syntax-tokenizes changed files to count code lines. |
| 1,310 / 1,122 ms | `node:sqlite` `run` in `sessions/search-index.ts`, from the 10-minute backfill | One `put` of a conversation's spoken lines into the trigram FTS table, in a single synchronous transaction. |
| 1,027 ms | oRPC `stringifyJSON` (590 ms) plus `summaryOf` (179 ms), for `GET /agents` | Serializes the full archived fleet (2,774 entries) on each request. |

Where the five minutes of main-thread CPU went, inclusive:

| CPU in 5 min | What |
| --- | --- |
| 25.2 s | `walkWorkspaceTree`: 20.8 s of it is gitignore matching in `@intentic/workspace-ignore` and the `ignore` package |
| 16.0 s | Garbage collection |
| 13.2 s | Attributing changed files to agents (`origins.ts`), including 1.5 s of registry lookups |
| 13.0 s | `child_process.spawn` on the main thread: managed-process states every 2 s (2.5 s), the tmux fingerprint every 2 s (2.5 s), terminal pane PIDs for the port scan (2.3 s), `system.routes` (1.5 s), the docker and llama-server status checks (1.6 s), history snapshots (1.2 s) |
| 5.8 s | oRPC response serialization (`stringifyJSON` plus `serialize`) |
| 5.5 s | Building `Error` objects for failed fs calls (`handleErrorFromBinding`). The caller resumes from the thread pool, so it is not on the stack. |
| 4.1 s | Port scan: `readlink` over `/proc/*/fd/*` |
| 3.3 s | `pathWeight` (the metric above) |
| 3.3 s | Shiki tokenizing for code counts |
| 2.8 s | Synchronous SQLite |
| 1.7 s | `structuredClone` of a run's rows on every `/agent/attach` (`turn-runs.ts`) |

The most expensive single freeze is the telemetry measuring itself. Apart from GC, every item above is work redone
on a timer or on every request, for an answer that changes only when a file, a landing, a process or a turn
changes.

### What the heavy reads cost on this data

Run against the real files with the daemon's own modules, on a quiet loop.

| Operation | Wall | Longest main-thread block |
| --- | --- | --- |
| `count()` on a 60 MB transcript (149 rows), called at every turn start and settle | 444 ms | 148 ms |
| `window()` default page on the same record | 444 ms | 134 ms |
| `read()` whole record | 540 ms | 381 ms |
| `JSON.stringify` of that record | 337 ms | 337 ms |
| said-index search, `"performance"`, cold cache | 2,221 ms | 2,221 ms (synchronous) |
| said-index search, `"the"`, warm | 160–337 ms | same |
| `agents.json` load (3.7 MB, 2,774 entries, zod) | 81 ms | 62 ms |

## 2. The tunnel

A request on the tunnel lane crosses: browser → Fly's proxy → the Bun edge (`@intentic/ingress`) → an HTTP/2 client
over a loopback TCP bridge → a WebSocket over TLS to the sandbox → another loopback bridge → the daemon's HTTP/2
server → an HTTP/1.1 request to the daemon's own `127.0.0.1` listener → Hono.

The harness ran the installed `ingress-protocol.js` on both ends: the edge half under Bun 1.4.2, as in production,
and the daemon half under Node 24, joined by a real `ws` WebSocket. Between them sat a TCP proxy that delays each
direction by half the RTT and can model a bandwidth-limited FIFO link. Each run timed a download of 64 KB chunks
for 6 s, fifteen small requests on an idle tunnel, ten more during a download, and an 8 MB upload during a
download.

| RTT, link | Windows | Download | Upload | Small request, idle → during download |
| --- | --- | --- | --- | --- |
| 20 ms, unlimited | current (Bun edge) | 2.8 MB/s | 2.1 MB/s | 23 → 43 ms |
| 20 ms, unlimited | 16 MB stream and connection (Bun edge) | 394 MB/s | 95 MB/s | 23 → 29 ms |
| 50 ms, unlimited | current | 1.2 MB/s | 0.9 MB/s | 54 → 104 ms (max 190) |
| 50 ms, unlimited | 16 MB / 16 MB | 208 MB/s | 97 MB/s | 54 → 53 ms |
| 100 ms, unlimited | current | 0.6 MB/s | 0.4 MB/s | 104 → 204 ms |
| 100 ms, unlimited | 16 MB / 16 MB | 90 MB/s | 40 MB/s | 104 → 103 ms |
| 50 ms, 100 Mbit/s | current | 1.1 MB/s (8.7% of the link) | 0.7 MB/s | 54 → 114 ms (max 175) |
| 50 ms, 100 Mbit/s | 16 MB / 16 MB | 11.8 MB/s | 6.2 MB/s | 54 → **693 ms (max 1,306)** |
| 50 ms, 100 Mbit/s | 1 MB stream, 2 MB connection (Bun edge) | 7.3 MB/s | 5.7 MB/s | 54 → 93 ms (max 125) |
| 50 ms, 100 Mbit/s | 1 MB / 1 MB (Node edge) | 10.5 MB/s | 8.2 MB/s | 54 → 88 ms (max 108) |

Three findings:

- The connection window is the cap. `openIngressSession` and `serveIngressSession` pass `initialWindowSize`,
  which only sizes streams. Neither calls `setLocalWindowSize`, so the session-wide window stays at 65,535 bytes
  in both directions.
- Bun's HTTP/2 client stalls if the connection window is raised above the stream window. With a 32 MB connection
  window over a 1 MB stream window, a Bun 1.4.2 client receives exactly 1 MB and then nothing more. Matching the
  two, or keeping the connection window at most twice the stream window, works (2.1–2.5 GB/s on loopback). Node
  handles any combination.
- Windows much larger than the link needs add queueing. With 16 MB windows on a 100 Mbit/s link, the transfer
  fills the bottleneck queue and a small request waits 0.7–1.3 s behind it. Windows sized to the bandwidth-delay
  product (1–2 MB here) keep 60–90% of that throughput and add less than a round trip. The underlying issue is that
  one TCP connection carries both interactive and bulk traffic.

On loopback with no added delay, 16 concurrent clients got 2,071 requests/s through the tunnel against 10,447
direct. The daemon half spent 216 µs of CPU per small request and the Bun edge 176 µs, while the origin's own
handling cost 38 µs. The daemon half runs on the same event loop as everything in section 1.

Measured live from inside the sandbox, `/health` direct takes 0.7 ms. On the public tunnel, each request on a warm
HTTP/2 connection takes 155–335 ms (median about 165 ms), and the edge alone answers in about 80 ms. The owner's
ingress is behind Cloudflare, so a request from this machine to its own sandbox crosses the internet twice.

Three smaller costs on the same path:

- The daemon compresses no responses. A full `/workspace/tree` is 553 KB of JSON, 75 KB gzipped and 59 KB with
  brotli. The fleet list compresses 6×, a transcript page 3–4×.
- `loopback-listener.ts` hands the TLS server a wrapper Duplex, so the server's own `setNoDelay` does not reach the
  socket and Nagle's algorithm stays on. The first request on a new TLS connection took 49–53 ms. With
  `socket.setNoDelay(true)` on the router it took 7–9 ms. Steady streaming was barely affected.
- CORS preflights are cached for 600 s, but per URL. Each first request to a new `/workspace/raw?path=…` or
  `/agents/<id>/diff` URL pays one extra round trip on the remote lanes.

### A tunnel that dies silently is not redialled

The edge pings every 15 s and drops a tunnel after 45 s of silence. The daemon side (`ingress-tunnel.ts`) sends no
pings, sets no timeout and enables no TCP keepalive. It redials only when the WebSocket reports `close`. The
reproduction ran the installed `startIngressTunnel` against a proxy that went silent for 5 s and closed its edge
leg, which is what a host sleep or a network change looks like from the sandbox. The edge was ready for a new
tunnel 5 s later. For the remaining 145 s of the test, the daemon kept reporting `connected() = true` and did not
redial. Nothing will arrive on that socket again, so the sandbox stays unreachable over the tunnel until something
outside the daemon kills the connection.

## 3. The same-machine lane

The editor prefers the loopback TLS lane, then the tunnel, then plain HTTP/1.1 on `127.0.0.1`. Measured with
`curl.exe` on `rog`'s Windows side, where the owner's browser runs:

| From Windows to this sandbox | First request | Each later request |
| --- | --- | --- |
| `https://82789f4106b4.local.intentic.dev:30559` (loopback TLS) | 148 ms (TLS handshake 128 ms) | 0.6–1.1 ms |
| `http://127.0.0.1:30559` (loopback, plain) | 2.4 ms | 0.5–0.7 ms |
| `https://sandbox-82789f4106b4.radarsu.com` (tunnel) | 371 ms | 157–197 ms |

Port 30559 is what `localDaemonPort(id)` in `sandbox-run` derives for this id, and where Docker publishes 8788.
The telemetry does not record which lane a browser used.

The lane can be lost. When a request on loopback reaches the 45 s deadline,
`sandboxAuthFetch.ts` calls `demote()` directly, without the reachability probe that `demoteIfUnreachable`
performs. The demotion lasts 60 s and doubles on each repeat, up to 30 minutes. The streak resets only when the
user switches sandboxes or reloads the page.

Deadlines are hit because the daemon is slow, not because the path is broken. 131 requests reached the deadline in
13 bursts: `/git/changes` 43, `/workspace/tree` 33, `/capabilities` 21, `/system/terminals` 17. Each burst moves a
browser on the same machine onto the tunnel, with its 165 ms round trips and 64 KB window, to reach the same
daemon. Every request gets slower, and the daemon is no faster for it.

On the plain HTTP/1.1 lane, `streamBudget.ts` leaves two of the browser's six connections for ordinary requests,
so two slow calls like the ones above block every other request.

## 4. Disk and git

Git itself is cheap, and contention is what makes it slow. Uncontended, through the daemon's own forker, `rev-parse`
takes 1.5 ms, `remote -v` 1.4 ms, and `status --porcelain=v2 -uall` 12 ms on the 6,358-file `intentic` checkout.
The slow git calls in the telemetry come from queueing: `git.run.wait` reaches 1.8 s behind the four bulk slots and
the repo locks, and `git.scan` reaches 80 s, on a machine whose load average passes 15 one minute in ten. The
daemon starts about 16 git processes a second through the forker. It also forks at least 2.7 more per second
directly from its main thread, which show up for a moment as copies of the 860 MB daemon. Set against the 13 s of
`spawn` in the profile, that is several milliseconds of frozen loop per process.

The daemon rebuilds the workspace tree from scratch whenever it is asked for. A full walk is 5,000 entries (the
budget) at about 350 ms of syscalls, plus the ignore matching that dominates the profile. The editor refetches the
whole tree on every file-watch event and every 120 s, each agent scope walks its own worktree, and the coalescer
shares a walk for only 500 ms. Three concurrent walks took 1.1–1.8 s on this machine. During them, a small
`readFile` on the same daemon went from p99 9–11 ms to p99 268 ms with the default four libuv threads, and 112 ms
with 64.

The disk is fast enough: a 4 KB write plus `fsync` takes 1.8 ms at p50 and 7–16 ms at p99 (ext4 on the WSL disk).
The storage formats are what cost time:

- Transcripts are one JSONL file per conversation, read whole for every `count`, `window`, `read` and `findBack`
  (numbers in section 1). 149 rows can weigh 60 MB, because rows carry whole tool outputs.
- The said index is a 188 MB SQLite trigram FTS database, queried synchronously on the main thread.
- `agents.json` is 3.7 MB and is rewritten whole on each registry change.
- 49 worktrees hold 13 GB under `/history/worktrees`.

## 5. The editor

- First load preloads 147 modules, 4.67 MB raw and 1.26 MB gzipped, before the first paint. There is 19.3 MB of
  JavaScript across 534 assets in all, and the service worker caches nothing.
- About 50 `useSandboxQuery` reads each make their own HTTP request, with their own headers, auth and (on remote
  lanes) preflight. Freshness is pushed over `/events`, but it arrives as an invalidation, which the editor answers
  with a full refetch.

## What to do, ranked

Ordered by how much of the remote feel each removes for the work it takes. Evidence for each is in the sections
above.

### Days: small diffs, large effect

| # | Change | Expected effect |
| --- | --- | --- |
| 1 | Stop computing `pathCharacters` by iterating every path, in `expiry.ts`, `origins.ts` and `landed-presence.ts`. Keep a running total on insert and delete, or drop the field. | Removes a 0.2–2.9 s freeze every minute. |
| 2 | Make `origins.forRepo` incremental. Cache the map from path to landing per `(repo, head)` and rebuild it only when a landing or `head` changes. | Removes 1–1.5 s from every `/git/changes`, about 13 s of CPU per 5 minutes. |
| 3 | Probe before demoting on a deadline: `timedOut()` should call `demoteIfUnreachable`, not `demote`. | Same-machine users stay on loopback when the daemon is busy, instead of spending up to 30 minutes on the WAN. |
| 4 | Size the tunnel's windows to the bandwidth-delay product. Call `setLocalWindowSize` on both sessions: stream 1 MB and connection 2 MB (Bun needs the connection window at most twice the stream window), or a few MB on both. | On a 100 Mbit/s, 50 ms link: 1.1 → 7–10 MB/s, against a 12.5 MB/s ceiling. Small requests stop paying an extra round trip during transfers. |
| 5 | Ping from the daemon side of the tunnel, for example every 15 s, and close after 45 s without a pong. | A sandbox reconnects within a minute of a sleep or a network change. Today it does not reconnect at all. |
| 6 | Move `node:sqlite` search and backfill to a worker thread, and split backfill `put`s into bounded batches. | Removes the 1–2 s freezes during search and every 10-minute backfill. |
| 7 | Compute code counts off the main thread, or count lines without a syntax tokenizer. | Removes 1–1.4 s freezes on `/git/changes`. |
| 8 | Give transcripts a sidecar row index (count and byte offsets), read pages with positioned reads, and stop reading whole records on the turn path. | `count` drops from 444 ms to near zero. Opening a long chat reads one page of kilobytes instead of the whole 60 MB file. |
| 9 | Compress JSON responses over 1 KB with zstd or brotli, per `Accept-Encoding`. | 3–9× less data on the tunnel: the tree 7–9×, the fleet 6×, transcript pages 3–4×. |
| 10 | Call `socket.setNoDelay(true)` in the loopback router before it hands the socket to a server. | 45 ms less on each new TLS connection. |
| 11 | Set `UV_THREADPOOL_SIZE` to 32 or more in `docker-entrypoint.sh`. | Small reads stop queueing behind walks (p99 268 → 112 ms measured). |
| 12 | Give the daemon its own cgroup: `memory.swap.max` at 0 or near it, and higher `cpu.weight` and `io.weight` than agent turns. The entrypoint already writes `memory.high`, so cgroup2 is delegated. `memory.low` helps against the global reclaim measured here only if the container itself starts with a reservation. On `rog`, `vm.swappiness=150` is the owner's WSL setting to revisit. | Takes the daemon out of the swap-in freezes. In minutes with ≥100k daemon major faults, 26% had a freeze over 5 s, against 0.2% under 1k. |

### Weeks: stop recomputing

- Keep the workspace tree resident. The watcher worker already sees every change, so it can hold the tree, its
  ignore decisions and its sizes, and send the editor deltas instead of a full walk. This removes the largest CPU
  consumer in the profile and most of the libuv queueing.
- Replace the polling spawns with events or cheap reads. The tmux fingerprint and managed-process states every
  2 s, the pane PIDs, and the docker and llama-server status checks cost 13 s of main-thread CPU per 5 minutes,
  and the port scan's `readlink` of every fd another 4.1 s. Read `/proc/net/tcp` and resolve an inode to its owner
  only when a new listener appears. Anything that has to spawn goes through a helper process, as git already does.
- Paginate `/agents`: the live fleet whole, the archive as pages or deltas.
- Share immutable snapshots of a run's rows between attaches, where each `/agent/attach` now runs `structuredClone`.
- Shrink the heap to under 300 MB in steady state, and bound every cache by bytes. The expiry tracker adds every
  moved path to every open landing (254 entries today), so it grows without limit. Retained heap is what swap and
  GC make expensive.
- Sync the editor by snapshots and deltas. One subscription channel (WebSocket now, WebTransport later) carries the
  state the ~50 queries read today and pushes changes in place of invalidations. That removes per-request auth and
  preflights, and a view opens on data the browser already holds.

### Rewrite level: take interactive traffic off the busy loop

One Node event loop carries both the traffic a person waits on (terminal bytes, file reads, the tree, event
fan-out, the tunnel itself) and the heavy orchestration (git, landing, attribution, indexes, agent SDKs). Any
recomputation, GC pause or swap-in in the second freezes the first. Moving the same design to Bun would not fix
that: Bun still runs one loop, and its HTTP/2 client has the flow-control bug above.

- **A front process in Rust** (tokio, hyper, `h2`, `quinn`) that owns the network edge and everything a person
  waits on:
  - The tunnel client, the loopback TLS listener and the preview proxy.
  - Terminal byte streams.
  - Raw file reads and writes, and uploads.
  - The resident tree, fed by inotify.
  - Session verification.
  - `/events` fan-out.

  It is small enough to pin in memory at high CPU and IO priority. The Node process stays the orchestrator, since
  the agent SDKs are JavaScript, and serves the front over a Unix socket. When Node stalls, typing, scrolling and
  opening files keep working, and only the views that need Node show as busy.
- **A resident git service.** A long-lived process (gitoxide, or a `git cat-file --batch` pool with status driven
  by a file watcher) replaces about 16 spawns a second, and reads without taking the repo locks that lands hold.
- **QUIC for the tunnel and the remote lanes.** Separate streams remove TCP's head-of-line blocking between a
  terminal and a download. Connection migration and 0-RTT resumption cover a laptop waking on another network.
  WebTransport gives the editor one multiplexed channel with no per-request preflight. Until then, two tunnels
  (interactive and bulk) remove most of the queueing measured above.
- **A log-structured conversation store.** Rows go in an indexed log, and large tool outputs are stored out of
  line (content-addressed, zstd). Opening, counting, paging and searching a conversation then cost what they
  return.

## Method

The telemetry was parsed from `/history/logs`. `resource-metrics.jsonl` samples every minute. `perf.jsonl` and
`client.jsonl` record only operations over their slow thresholds (1.5 s for a browser request), so counts taken
from them are counts of slow operations.

The live daemon's inspector was opened with SIGUSR1 and profiled over CDP (`Profiler.start` at a 1 ms interval, for
300 s), then closed with `process._debugEnd()`. Busy runs are maximal spans of non-idle samples, and callers are
attributed to the innermost `/opt/sandbox/dist` frame.

The reproductions imported the installed modules from `/opt/sandbox/dist` and read the real
`/history/transcripts`, `said.db` and `agents.json`. The tunnel harness, the Nagle test and the silent-death test
used the installed `ingress-protocol.js` and `ingress-tunnel.js`. The scripts are in `/tmp/perf` of the sandbox
that ran them.

Load was real. Seven agents and their test runs pushed the load average to 12–17 during the measurements, which
inflates every wall-clock number and is the condition the owner works in. The WAN figures come from emulated delay
and bandwidth, except the live `/health` measurements.

## What was done

Each of the twelve day-sized fixes, with the test that pins it and what it measures now. Figures are from the same
harnesses as above, under Node 24 unless noted, on the same loaded machine.

| Fix | Where | Before | After |
| --- | --- | --- | --- |
| Path-weight metric kept as a running total | `agents/registry/expiry.ts` (`createPathLists`), `origins.ts`, `landed-presence.ts` | 0.2–2.9 s freeze every minute | No walk. Reading the metric reads a number |
| Origins answer reused until head or landings move, and registry lookups indexed | `agents/land/origins.ts`, `agents/registry/agents-registry.ts` | 1.1–1.5 s per `/git/changes`, and `entryOf` scanned 2,774 entries per call | A repeat scan at the same head runs no git and walks nothing. Lookups are O(1) |
| Loopback demoted only when the tunnel answers and loopback does not | `_editor/web` `endpoint.ts` (`shortcutFailedAlone`), `useEndpoint.ts`, `sandboxAuthFetch.ts` | Any 45 s deadline moved the browser to the WAN for 1–30 min | A busy daemon keeps the fast lane. A hung relay still demotes |
| Session-wide h2 window of 2 MB over 1 MB streams | `sandbox-contract` `ingress-protocol.ts` | 50 ms, 100 Mbit/s: 1.1 MB/s down, 0.7 up, small request 114 ms | 7.3 MB/s down, 5.6 up, small request 94 ms (Bun edge) |
|  |  | 100 ms RTT: 0.6 MB/s down, small request 204 ms | 9.3 MB/s down, small request 104 ms |
| Daemon pings the edge, with the heartbeat moved into the shared contract | `ingress-tunnel.ts`, `sandbox-contract` `tunnel-heartbeat.ts` | A silently dropped path was never redialled | Redialled 61 s after the path died |
| Phrase index on a worker thread, puts written in batches | `sessions/search-index.ts`, `search-store.ts`, `search-index-worker.ts` | Search blocked the loop 87 ms (warm) to 2.2 s (cold) | 1–2 ms of main-thread block per search on a copy of the live index. Reads answer between a long put's batches |
| Code counts tokenized on a worker thread | `git/changes/code-counts.ts`, `code-counts-worker.ts` | 1–1.4 s freezes on `/git/changes` | Tokenizing holds only the worker |
| Transcript rows indexed by byte offset | `sessions/transcript-record.ts` | `count` on the 60 MB record: 208 ms with a 96 ms block. Default page 444 ms with a 134 ms block | First `count` 26 ms (a byte scan, 2 ms block), then 0. Default page 40 ms with a 23 ms block, spent parsing the rows it returns |
| JSON answers compressed (zstd, brotli, gzip) | `compress-responses.ts`, mounted in `app.ts` | Full tree 583 KB on the wire | 79 KB with zstd, 74 KB with brotli |
| Nagle off on the loopback router's sockets | `platform/listeners/loopback-listener.ts`, now the front's `listen.rs` | First request on a new TLS connection 49–53 ms | 7–9 ms |
| libuv pool of 32 threads | `docker-entrypoint.sh` | Small reads behind a tree walk: p99 268 ms at 4 threads | p99 112 ms measured at 64 |
| Daemon cgroup with no swap and 10× cpu and io weight, its children moved to `workload` | `docker-entrypoint.sh`, `platform/resources/workload-priority.ts`, now the front's `cgroup.rs` | The daemon's heap swapped (400–800 MB), with multi-second freezes on fault-in | Takes effect on the next container start, not yet run live |

Three things the table does not show:

- The branch was rebased onto main mid-work, across the storage move to per-conversation units under
  `/history/conversations/` and SQLite (`conversations.db`). The row index and the search worker were rebuilt on the
  new code rather than on what this audit first measured.
- The entrypoint's cgroup and thread-pool changes need a rebuild and a container recreate to take effect, which is
  the owner's call. Its tests stage the whole cgroup root, so a test run does not move this machine's processes.
- The "Rewrite level" list is under way as the native front, below; the "Weeks" list folds into its phases. The
  largest remaining costs in the profile are the tree re-walks (25 s of CPU per 5 minutes) and the polling spawns
  (13 s), phases 5 and 3.

## The rewrites

The plan and its reasoning are [native-front.md](../design/native-front.md): a Rust process (`_sandbox/front`) that
owns every port and the tunnel and supervises Node, which then serves HTTP on a Unix socket. Phase 1 is done;
these are its figures, on the same loaded machine.

| What | Measured |
| --- | --- |
| The front's own hop, stand-in daemon, keep-alive | 149 µs p50 through the front against 84 µs straight to Node's socket (p99 336 and 364) |
| The same on the real daemon's `/health` | 313 µs p50 through the front, 217 µs direct; the live daemon's JS preview-proxy hop costs about as much (353 against 244) |
| Previews while the daemon stalls 100 ms of every 150 | p99 1.48 ms through the front, against 100 ms through a JS proxy on the stalled daemon, the old shape |
| Node killed mid-flight | the request sent right after the kill was answered 1,048 ms later, by the restarted Node, not failed |
| Tunnel daemon half, through the real Bun edge on localhost | 263–294 µs p50 through the front against 93–161 for the TS half; not like for like, since the TS half ran inside the edge's own process and the front adds two process boundaries a real tunnel already has |

What phase 1 does not move: a request Node must answer still waits for Node, stalls included (p99 99 ms in the same
stall test). The phases after it are what take terminals, events, files, the tree and git reads off Node's loop.

