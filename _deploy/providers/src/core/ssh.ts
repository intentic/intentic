import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, connect as tcpConnect } from "node:net";
import type { Readable } from "node:stream";
import { pollUntil } from "@intentic/base/async";
import { Client } from "ssh2";

export interface SshResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export interface SshSession {
    // `onOutput` streams stdout+stderr chunks as they arrive; the returned result still resolves in full.
    readonly exec: (command: string, onOutput?: (chunk: string) => void) => Promise<SshResult>;
    readonly dispose: () => Promise<void>;
    // SFTP-streamed transfer; real executor only, test fakes may omit.
    readonly download?: (remotePath: string, localPath: string) => Promise<void>;
    readonly upload?: (localPath: string, remotePath: string) => Promise<void>;
    // Loopback listener piped to remoteHost:remotePort via ssh2 direct-tcpip; real executor only, fakes may omit.
    readonly forward?: (remoteHost: string, remotePort: number) => Promise<{ readonly port: number; readonly close: () => Promise<void> }>;
}

export interface SshTarget {
    readonly address: string;
    readonly user: string;
    readonly privateKey: string;
    readonly port: number;
    // "direct" dials address:port; "cloudflared" bridges through a cloudflared access tcp tunnel.
    readonly via?: "direct" | "cloudflared";
}

// Injectable transport for host commands, unit-testable with a fake. `dispose` tears down any cloudflared forwarders; a
// no-op for direct-only runs.
export interface SshExecutor {
    readonly connect: (target: SshTarget) => Promise<SshSession>;
    readonly dispose?: () => Promise<void>;
}

// Trust store behind host-key verification, keyed by address:port; keys are the host's public key as base64.
export interface HostKeyStore {
    readonly get: (host: string, port: number) => Promise<string | undefined>;
    readonly set: (host: string, port: number, key: string) => Promise<void>;
}

// Trusts each host's first key and pins it; nothing persists across process restarts.
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

// Trust-on-first-use: records an unseen host's key, or checks a seen host's key for a match/mismatch.
export const verifyHostKey = async (store: HostKeyStore, host: string, port: number, presented: string): Promise<"ok" | "mismatch"> => {
    const known = await store.get(host, port);
    if (known === undefined) {
        await store.set(host, port, presented);
        return "ok";
    }
    return known === presented ? "ok" : "mismatch";
};

// Drains a readable stream into a boxed string sink.
const collect = (stream: Readable, sink: { value: string }, onOutput?: (chunk: string) => void): void => {
    stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        sink.value += text;
        onOutput?.(text);
    });
};

// A running `cloudflared access tcp` forwarder: a local listener bridged to the host's SSH through its tunnel; one per
// hostname, shared across sessions.
interface CloudflaredForwarder {
    readonly port: number;
    readonly child: ChildProcess;
    // Bounded tail of cloudflared's stderr, appended to a failed connect's error for context.
    readonly stderr: () => string;
}

// Binds a loopback socket on port 0 to reserve a free port, then releases it for cloudflared to claim; a small race
// window is acceptable.
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

// Polls the port until it accepts, or fails immediately once `failure()` reports cloudflared has already exited.
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

// Starts `cloudflared access tcp` for `hostname` and resolves once its local listener accepts; rejects if cloudflared
// is missing from PATH or the listener never comes up.
const startCloudflaredForwarder = async (hostname: string): Promise<CloudflaredForwarder> => {
    const port = await reserveLocalPort();
    const child = spawn("cloudflared", ["access", "tcp", "--hostname", hostname, "--url", `127.0.0.1:${port}`], {
        stdio: ["ignore", "ignore", "pipe"],
    });
    // Keeps only cloudflared's most recent stderr; older output is dropped.
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

// Retry budget for a connect during cloudflared tunnel warm-up, before DNS/edge propagation finishes.
const REACHABLE_TIMEOUT_MS = 60_000;
const REACHABLE_INTERVAL_MS = 3_000;

// Keepalive fails a dead transport in ~15s; the exec ceiling only bounds a wedged remote command.
const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 5_000;
const KEEPALIVE_COUNT_MAX = 3;
const EXEC_TIMEOUT_MS = 30 * 60_000;

// Retries connecting until it succeeds or the deadline elapses, propagating the final error unchanged on timeout. Only
// for the connect before a mutation; probes stay single-shot.
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

// Verifies the host key via `store` before connecting; a cloudflared target dials a memoized per-host forwarder, but
// the store stays keyed on the logical address:port.
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
            // Evict the entry immediately if the forwarder fails to start.
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
                // Removed once ready to avoid a double reject; appends cloudflared's stderr so a bare ECONNRESET is
                // actionable.
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
                    // Tracks in-flight execs so a dropped transport can reject them instead of resolving as a silent
                    // close.
                    const inflight = new Set<(error: Error) => void>();
                    const failInflight = (error: Error): void => {
                        // Each failer removes only itself from the set, safe during direct Set iteration.
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
                                // Backstop for a wedged remote command on a live transport; the session is unusable
                                // after, so end it.
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
                        // SFTP get/put streamed directly to/from the local path, not through `exec`'s string sink.
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
                    // Rejects on a key mismatch or store failure; keyed on the logical address:port, not the
                    // forwarder's port.
                    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
                        verifyHostKey(store, target.address, target.port, key.toString("base64"))
                            .then((outcome) => {
                                if (outcome === "mismatch") {
                                    reject(
                                        new Error(
                                            `host key mismatch for ${target.address}:${target.port}: refusing to connect (possible MITM, or the host was rebuilt; remove its entry from .known-hosts.json to re-trust)`,
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
                        // Forwarder failed to start or already exited, nothing to tear down.
                    }
                }),
            );
        },
    };
};

export const sshExecutor: SshExecutor = createSshExecutor();
