# The native front

Why the sandbox's network edge, and step by step its hot paths, move out of the Node daemon into a Rust process in
front of it, and the order that happens in.

## The problem it answers

Local-like feel means the interactive path (keys to a pane and back, file bytes, the tree, the event stream) never
waits on one JavaScript event loop, its garbage collector or its restarts, and that the tunnel stops being one TCP
stream everything queues behind. The measurements behind that are in
[sandbox-performance-analysis.md](../audits/sandbox-performance-analysis.md); the structural causes were:

- **Hops.** A tunneled request crossed the Bun edge, a loopback TCP bridge, the WebSocket, a second bridge, the
  daemon's h2 server, an h1 hop to the preview proxy on `:5173` and a second one to Hono on `:8787`: four JavaScript
  HTTP layers inside the box, each on the one loop every terminal and stream also waits on.
- **Terminals.** One `tmux -C` process per browser socket, `%output` decoded byte by byte in JavaScript, one frame
  per output line, output dropped past 1 MiB and tmux never throttled.
- **The tree.** The browser drives `walkWorkspaceTree`: every tab refetches after every watcher batch, each fetch two
  full walks with fresh `.gitignore` matchers and ~570 KB of zod-validated JSON (25 s of CPU per five minutes).
- **Events.** Every tool call of every running turn broadcast the whole roster to every stream, each frame
  validated, copied and stringified per subscriber, with no replay.
- **Spawns.** 2-second pollers spawning tmux and ps, ~16 git processes a second, a history snapshot per minute.

## Decisions

**Node decides, the front remembers.** Every policy stays in Node: route floors, guests, fences, control rungs,
the passkey policy, which upstream a preview host names, what a refusal page says. The front asks (a preview route,
later an authorization verdict), caches the answer briefly, and is told when to drop it. Re-implementing the policy
in Rust would put the same security-relevant rules in two languages; a question over a Unix socket costs tens of
microseconds and keeps one source.

**One definition across the two languages.** The control lane's types are Rust (`front-wire`), and `cargo test`
emits them as TypeScript into the contract, which CI compares with what is committed. Header names Node must
recognize are exported as literal types, so a Node constant that drifts fails to compile. A rule the front has to
run itself (the host-label parsing) is held to one fixture file that both test suites read.

**The front is the parent.** The entrypoint execs the front, which spawns Node in its own process group and
restarts it after a crash while every listener, tunnel and socket stays open; a deliberate exit (0, or 78 for a
refused config) still ends the container, so idle-stop and config refusal behave as before. The front also owns
cgroup placement, since it is the one process that knows which children belong on the interactive path.

**Built on the image's own Debian release.** The binary is compiled in `rust:*-slim-trixie` by a BuildKit stage
and exported as a file, so the image links the glibc it carries whatever machine builds it (the owner's Arch host
has a newer one), no host needs Rust, and CI needs no cross-compilation or artifact passing.

**The edge holds the certificate** (the owner's choice, for the QUIC phase). HTTP/3 and WebTransport need UDP to
reach the edge, which neither Fly's proxy nor Cloudflare's tunnel carries, so the edge terminates TLS itself on TCP
and UDP with the platform-issued `*.sbx` certificate. A consequence: `fly-replay` needs Fly's HTTP handler, so hosted
machines then dial the tunnel like every other sandbox, and the edge asks the platform to wake a stopped one.

## Phases

Each lands alone, deletes the Node code it replaces, and is measured against the audit's baseline.

1. **The front owns the box's edge** (done). Ports, TLS sniffing, the preview relay, the tunnel, Node on a Unix
   socket, supervision, cgroups. Measured on a stand-in daemon: the front adds ~65 µs p50 to a request; a daemon
   killed mid-flight answered the request already sent to it ~1 s later, from the restarted process.
2. **Two TCP lanes.** A `bulk` lane in RouteMeta (uploads, downloads, runner packs, sync) dialed as its own
   WebSocket, so a transfer never queues a keystroke; `TCP_NOTSENT_LOWAT` on the interactive one.
3. **Terminals and the tmux channel.** One control client per session shared by every viewer, coalesced binary
   frames, bounded viewer queues with snapshot resync, `pause-after`; Node's tmux queries over the persistent
   control connection instead of spawns; authorization verdicts cached in the front.
4. **Events and live turns.** Published once per audience, fanned out with per-key coalescing and `Last-Event-ID`
   replay; per-conversation roster deltas; field-level transcript patches instead of whole-card clones.
5. **The resident tree and file bytes.** An inotify-backed tree per root with generation-numbered deltas, served from
   memory; ranged, cached file bytes and streamed uploads.
6. **The git service.** gitoxide for reads and a watcher-driven live status; writes stay on the git CLI.
7. **The conversation store.** CRC-framed zstd rows with a fixed-width index (row number stays the key), large tool
   outputs out of line as content-addressed blobs, one fdatasync per settled turn.
8. **The edge in Rust**, at parity: its own TLS, the cluster, the lanes, hosted machines on the tunnel.
9. **QUIC, HTTP/3 and WebTransport**, with the WebSocket lanes kept as the fallback wherever UDP is not carried.
