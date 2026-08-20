import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, connect as tcpConnect } from "node:net";
import type { Readable } from "node:stream";
import { pollUntil } from "@intentic/engine";
import { Client } from "ssh2";

export interface SshResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export interface SshSession {
    // `onOutput` taps stdout+stderr chunks as they arrive (a long `docker compose up` streams its pull
    // progress live) — the full collected result still resolves as before.
    readonly exec: (command: string, onOutput?: (chunk: string) => void) => Promise<SshResult>;
    readonly dispose: () => Promise<void>;
    // Streamed binary file transfer over SFTP — the real executor only; test fakes may omit. Used to relay a
    // restic-repo tarball between two hosts THROUGH the CLI during a host migration, where neither host can
    // reach the other directly (a NAT'd local host opens no inbound ports). Streamed to/from a file, so a
    // multi-GB repo never buffers in memory the way `exec`'s string-collected stdout would.
    readonly download?: (remotePath: string, localPath: string) => Promise<void>;
    readonly upload?: (localPath: string, remotePath: string) => Promise<void>;
    // A local loopback listener whose every connection is piped to remoteHost:remotePort dialed FROM the
    // host (ssh2 direct-tcpip) — how the engine reaches the control-plane HTTP services (Forgejo :3000,
    // Komodo :9120) without touching their public Cloudflare routes. Real executor only; fakes may omit.
    readonly forward?: (remoteHost: string, remotePort: number) => Promise<{ readonly port: number; readonly close: () => Promise<void> }>;
}

export interface SshTarget {
    readonly address: string;
    readonly user: string;
    readonly privateKey: string;
    readonly port: number;
    // How to reach the host. "direct" (default) dials address:port over TCP. "cloudflared" reaches a NAT'd
    // host's SSH through its Cloudflare tunnel: the executor runs `cloudflared access tcp` to bridge the
    // tunnel hostname (address) to a local port and dials that instead. See createSshExecutor.
    readonly via?: "direct" | "cloudflared";
}

// The transport the host provider runs commands over. Injected so the provider is unit-testable with a
// fake; the default is the ssh2-backed executor below. `dispose` tears down any cloudflared forwarders the
// executor started (a no-op for direct-only runs); the CLI calls it when a command finishes.
export interface SshExecutor {
    readonly connect: (target: SshTarget) => Promise<SshSession>;
    readonly dispose?: () => Promise<void>;
}

// Persists the public key each host presented, keyed by address:port — the trust store behind host-key
// verification. The CLI backs this with a committed `.known-hosts.json`; an embedded control plane injects
// its own per-tenant (DB/vault) implementation. Keys are the host's public key as base64.
export interface HostKeyStore {
    readonly get: (host: string, port: number) => Promise<string | undefined>;
    readonly set: (host: string, port: number, key: string) => Promise<void>;
}

// A process-lifetime store: trusts the first key seen per host and verifies later connects against it, but
// nothing survives the process. The default for `sshExecutor`, and the safe baseline for tests/e2e (fresh
// hosts re-pin per run).
const hostKeyId = (host: string, port: number): string => `${host}:${port}`;

export const inMemoryHostKeyStore = (): HostKeyStore => {
    const keys = new Map<string, string>();
    return {
        get: (host, port) => Promise.resolve(keys.get(hostKeyId(host, port))),
        set: (host, port, key) => {
            keys.set(hostKeyId(host, port), key);
            return Promise.resolve();
        },
    };
};

// Trust-on-first-use + pinning. An unseen host's key is recorded and trusted; a seen host must present the
// exact same key, or it is a mismatch (a possible MITM, or the host was rebuilt). Pure but for the store —
// unit-testable without a live SSH server.
export const verifyHostKey = async (store: HostKeyStore, host: string, port: number, presented: string): Promise<"ok" | "mismatch"> => {
    const known = await store.get(host, port);
    if (known === undefined) {
        await store.set(host, port, presented);
        return "ok";
    }
    return known === presented ? "ok" : "mismatch";
};

// Drain a readable stream into a boxed string sink (a box avoids reassigning a captured binding).
const collect = (stream: Readable, sink: { value: string }, onOutput?: (chunk: string) => void): void => {
    stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        sink.value += text;
        onOutput?.(text);
    });
};

// A running `cloudflared access tcp` forwarder: a local listener on `port` that bridges to a host's SSH over
// its Cloudflare tunnel. One per tunnel hostname, reused across the many SSH sessions an apply opens.
interface CloudflaredForwarder {
    readonly port: number;
    readonly child: ChildProcess;
    // A bounded tail of cloudflared's stderr. cloudflared logs per-connection origin failures (e.g. the tunnel
    // hostname could not be resolved/reached) here for the forwarder's whole lifetime — surfaced when an ssh
    // connect through this forwarder fails, so a bare `read ECONNRESET` becomes an actionable cause.
    readonly stderr: () => string;
}

// Reserve a free loopback port by briefly binding :0, then release it for cloudflared to claim. A tiny race
// window (the port could be taken in between), acceptable for a one-shot per-host forwarder.
const reserveLocalPort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

// One TCP connect attempt to a loopback port; resolves whether it accepted.
const tcpProbe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = tcpConnect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });

// Poll a loopback port until it accepts; fail fast if cloudflared exited first (reported via `failure`) —
// the probe throws, which ends the wait then and there rather than after the whole deadline.
const waitForPort = async (port: number, failure: () => string | undefined, timeoutMs = 20000): Promise<void> => {
    const up = await pollUntil(
        async () => {
            const reason = failure();
            if (reason !== undefined) {
                throw new Error(`cloudflared access exited before its local forwarder came up: ${reason}`);
            }
            return tcpProbe(port);
        },
        { timeoutMs, intervalMs: 150 },
    );
    if (!up) {
        throw new Error(`cloudflared local forwarder on 127.0.0.1:${port} did not come up within ${timeoutMs}ms`);
    }
};

// Start `cloudflared access tcp --hostname <hostname> --url 127.0.0.1:<port>` and resolve once the local
// listener accepts. cloudflared must be on PATH (the sandbox image ships it). Rejects if the binary is
// missing or the listener never comes up.
const startCloudflaredForwarder = async (hostname: string): Promise<CloudflaredForwarder> => {
    const port = await reserveLocalPort();
    const child = spawn("cloudflared", ["access", "tcp", "--hostname", hostname, "--url", `127.0.0.1:${port}`], {
        stdio: ["ignore", "ignore", "pipe"],
    });
    // Keep only the tail — cloudflared is chatty over a long apply; the last couple KB carry the relevant error.
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    let exit: string | undefined;
    child.once("error", (error) => {
        exit = `spawn failed: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
        exit = `exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
    });
    try {
        await waitForPort(port, () => exit);
    } catch (error) {
        child.kill();
        throw error;
    }
    return { port, child, stderr: () => stderr };
};

// How long to keep retrying a connect that fails on tunnel warm-up, and how often. A host reached over a
// freshly-minted cloudflared tunnel is not reachable the instant its DNS is created — the record must propagate
// and the connector must join Cloudflare's edge, during which the dial fails (NXDOMAIN → ECONNRESET).
const REACHABLE_TIMEOUT_MS = 60_000;
const REACHABLE_INTERVAL_MS = 3_000;

// Transport liveness + command ceilings. A connect (TCP + handshake + auth) is bounded by readyTimeout; once
// connected, keepalive probes every 5s and gives up after 3 misses, so a transport that dies mid-command (the
// host's tunnel connector restarting, a dropped link) fails the session in ~15s instead of hanging forever —
// this exact hang wedged `intentic deploy plan` for 8+ minutes when a host tunnel restarted mid-read. The per-exec
// ceiling is deliberately generous: image pulls and restic backups legitimately run for many minutes, and
// nothing in a single exec should outlive the 30-minute apply lock — it exists to bound a genuinely wedged
// remote command (a stuck dockerd), not to police slow-but-alive work (keepalive already proves liveness).
const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 5_000;
const KEEPALIVE_COUNT_MAX = 3;
const EXEC_TIMEOUT_MS = 30 * 60_000;

// Connect over SSH, waiting out a transient warm-up failure. Retry until a session opens or the deadline
// elapses; on timeout the last connect error propagates UNCHANGED (the actionable `cloudflared tunnel …` one).
// Only for the connect that precedes a MUTATION — read/probe connects stay single-shot so `plan` never blocks
// on an unreachable host. Reuses the executor's memoized forwarder across attempts (a failed SSH connect keeps
// the forwarder cached, and cloudflared re-resolves DNS per connection, so a reused forwarder succeeds once the
// record propagates).
export const connectWithRetry = async (
    executor: SshExecutor,
    target: SshTarget,
    {
        timeoutMs = REACHABLE_TIMEOUT_MS,
        intervalMs = REACHABLE_INTERVAL_MS,
        log = () => {},
    }: { timeoutMs?: number; intervalMs?: number; log?: (message: string) => void } = {},
): Promise<SshSession> => {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 1; ; attempt++) {
        try {
            return await executor.connect(target);
        } catch (error) {
            if (Date.now() >= deadline) {
                throw error;
            }
            log(`waiting for ${target.address}:${target.port} to become reachable (it may still be booting), retrying (attempt ${attempt})…`);
            await delay(intervalMs);
        }
    }
};

// ssh2 is CommonJS with named exports (no default), so `import { Client }` is the correct interop form.
// Every connection verifies the host key against `store` (trust-on-first-use + pinning) before proceeding.
// A target with via:"cloudflared" is dialed through a per-host `cloudflared access tcp` forwarder (memoized
// so the many sessions of one apply share it); ssh2 connects to the local forwarder port, but the host-key
// store stays keyed on the LOGICAL address:port, so TOFU pinning is stable across runs.
export const createSshExecutor = (store: HostKeyStore = inMemoryHostKeyStore()): SshExecutor => {
    const forwarders = new Map<string, Promise<CloudflaredForwarder>>();

    const dial = async (target: SshTarget): Promise<{ host: string; port: number; stderr?: () => string }> => {
        if (target.via !== "cloudflared") {
            return { host: target.address, port: target.port };
        }
        let forwarder = forwarders.get(target.address);
        if (forwarder === undefined) {
            forwarder = startCloudflaredForwarder(target.address);
            forwarders.set(target.address, forwarder);
            // A failed start must not poison the cache — drop it so a later connect can retry.
            forwarder.catch(() => forwarders.delete(target.address));
        }
        const resolved = await forwarder;
        return { host: "127.0.0.1", port: resolved.port, stderr: resolved.stderr };
    };

    return {
        connect: async (target) => {
            const endpoint = await dial(target);
            return new Promise<SshSession>((resolve, reject) => {
                const client = new Client();
                // Connect/auth failures surface here; removed once ready so a later disconnect can't reject twice.
                // For a cloudflared target the transport error (e.g. ECONNRESET) hides the real cause — cloudflared
                // could not resolve/reach the tunnel origin — which is only in its stderr. Append that tail so the
                // failure is actionable. A short flush delay lets cloudflared log the origin failure it just hit
                // before we read the tail (the ssh error and cloudflared's log line race on the event loop).
                const onError = (error: Error): void => {
                    if (endpoint.stderr === undefined) {
                        reject(error);
                        return;
                    }
                    setTimeout(() => {
                        const detail = endpoint.stderr?.().trim();
                        reject(
                            detail ? new Error(`cloudflared tunnel to ${target.address} failed: ${error.message}\ncloudflared: ${detail}`) : error,
                        );
                    }, 50);
                };
                client.on("error", onError);
                client.on("ready", () => {
                    client.removeListener("error", onError);
                    // In-flight exec failers. A transport that dies mid-command (keepalive timeout, tunnel
                    // drop) must REJECT the command: the channel's own "close" would otherwise resolve it as a
                    // silent code-0 success. The post-ready "error" listener also keeps a keepalive failure
                    // from crashing the process as an unhandled Client error event.
                    const inflight = new Set<(error: Error) => void>();
                    const failInflight = (error: Error): void => {
                        // Each failer removes only itself from the set — safe during direct Set iteration.
                        for (const failExec of inflight) {
                            failExec(error);
                        }
                    };
                    client.on("error", failInflight);
                    client.on("close", () => failInflight(new Error(`ssh connection to ${target.address} closed before the command finished`)));
                    resolve({
                        exec: (command, onOutput) =>
                            new Promise<SshResult>((resolveExec, rejectExec) => {
                                let settled = false;
                                const fail = (error: Error): void => {
                                    if (settled) {
                                        return;
                                    }
                                    settled = true;
                                    inflight.delete(fail);
                                    clearTimeout(timer);
                                    rejectExec(error);
                                };
                                const finish = (result: SshResult): void => {
                                    if (settled) {
                                        return;
                                    }
                                    settled = true;
                                    inflight.delete(fail);
                                    clearTimeout(timer);
                                    resolveExec(result);
                                };
                                inflight.add(fail);
                                // Backstop against a genuinely wedged remote command on a live transport; the
                                // session is unusable after (the channel can't be reclaimed), so end it.
                                const timer = setTimeout(() => {
                                    fail(new Error(`ssh exec timed out after ${EXEC_TIMEOUT_MS / 60_000}m: ${command}`));
                                    client.end();
                                }, EXEC_TIMEOUT_MS);
                                client.exec(command, (error, stream) => {
                                    if (error !== undefined) {
                                        fail(error);
                                        return;
                                    }
                                    const stdout = { value: "" };
                                    const stderr = { value: "" };
                                    let code = 0;
                                    collect(stream, stdout, onOutput);
                                    collect(stream.stderr, stderr, onOutput);
                                    // The exit code arrives on "exit"; "close" fires after streams flush.
                                    stream.on("exit", (exitCode: number | null) => {
                                        code = exitCode ?? 0;
                                    });
                                    stream.on("close", () => {
                                        finish({ stdout: stdout.value, stderr: stderr.value, code });
                                    });
                                });
                            }),
                        dispose: () =>
                            new Promise<void>((resolveDispose) => {
                                client.on("close", () => {
                                    resolveDispose();
                                });
                                client.end();
                            }),
                        // SFTP get/put over the same connection. ssh2 streams the transfer to/from the local path,
                        // so the bytes never pass through `exec`'s utf8 string sink (which would corrupt binary).
                        download: (remotePath, localPath) =>
                            new Promise<void>((resolveTransfer, rejectTransfer) => {
                                client.sftp((sftpError, sftp) => {
                                    if (sftpError) {
                                        rejectTransfer(sftpError);
                                        return;
                                    }
                                    sftp.fastGet(remotePath, localPath, (getError) => (getError ? rejectTransfer(getError) : resolveTransfer()));
                                });
                            }),
                        upload: (localPath, remotePath) =>
                            new Promise<void>((resolveTransfer, rejectTransfer) => {
                                client.sftp((sftpError, sftp) => {
                                    if (sftpError) {
                                        rejectTransfer(sftpError);
                                        return;
                                    }
                                    sftp.fastPut(localPath, remotePath, (putError) => (putError ? rejectTransfer(putError) : resolveTransfer()));
                                });
                            }),
                        forward: (remoteHost, remotePort) =>
                            new Promise((resolveForward, rejectForward) => {
                                const server = createServer((socket) => {
                                    client.forwardOut(
                                        socket.localAddress ?? "127.0.0.1",
                                        socket.localPort ?? 0,
                                        remoteHost,
                                        remotePort,
                                        (error, stream) => {
                                            if (error) {
                                                socket.destroy(error);
                                                return;
                                            }
                                            socket.pipe(stream).pipe(socket);
                                            stream.on("error", () => socket.destroy());
                                            socket.on("error", () => stream.destroy());
                                        },
                                    );
                                });
                                server.once("error", rejectForward);
                                server.listen(0, "127.0.0.1", () => {
                                    const address = server.address();
                                    resolveForward({
                                        port: typeof address === "object" && address !== null ? address.port : 0,
                                        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
                                    });
                                });
                            }),
                    });
                });
                client.connect({
                    host: endpoint.host,
                    port: endpoint.port,
                    username: target.user,
                    privateKey: target.privateKey,
                    readyTimeout: READY_TIMEOUT_MS,
                    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
                    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
                    // ssh2 hands us the host's public key (Buffer, since no hostHash is set) and waits for the
                    // callback. A mismatch rejects the connect with a clear error before any command runs; a store
                    // read failure also fails closed. Keyed on the LOGICAL address:port, not the local forwarder.
                    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
                        verifyHostKey(store, target.address, target.port, key.toString("base64"))
                            .then((outcome) => {
                                if (outcome === "mismatch") {
                                    reject(
                                        new Error(
                                            `host key mismatch for ${target.address}:${target.port} — refusing to connect (possible MITM, or the host was rebuilt; remove its entry from .known-hosts.json to re-trust)`,
                                        ),
                                    );
                                }
                                callback(outcome === "ok");
                            })
                            .catch(reject);
                    },
                });
            });
        },
        dispose: async () => {
            const pending = [...forwarders.values()];
            forwarders.clear();
            await Promise.all(
                pending.map(async (forwarder) => {
                    try {
                        (await forwarder).child.kill();
                    } catch {
                        // Forwarder failed to start or already exited — nothing to tear down.
                    }
                }),
            );
        },
    };
};

export const sshExecutor: SshExecutor = createSshExecutor();
