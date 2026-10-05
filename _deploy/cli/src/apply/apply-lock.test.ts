import type { SshExecutor, SshResult, SshTarget } from "@intentic/providers";
import { acquireApplyLock, type ApplyLock, LockLostError, startLockHeartbeat } from "./apply-lock.js";

// Fake host fleet driven by the `#APPLYLOCK <op> <nonce> <ttl>` header each lock script starts with (a real shell reads
// it as a no-op comment). Clock ages locks past TTL for stale-takeover tests; `commands` records per-host op order.
interface FakeHost {
    nonce: string;
    expiresAt: number;
}
const lockResult = (stdout: string): SshResult => ({ stdout, stderr: "", code: 0 });

const createFakeFleet = (options: { unreachable?: ReadonlySet<string>; cannotWrite?: ReadonlySet<string> } = {}) => {
    const locks = new Map<string, FakeHost>();
    const commands: Array<{ host: string; op: string }> = [];
    const clock = { now: 1_000 };
    const unreachable = options.unreachable ?? new Set<string>();
    // Hosts whose acquire script hits an unwritable /opt/intentic (the `[ -w /opt/intentic ]` guard fails).
    const cannotWrite = options.cannotWrite ?? new Set<string>();
    const executor: SshExecutor = {
        connect: (target: SshTarget) => {
            const host = `${target.address}:${target.port}`;
            if (unreachable.has(host)) {
                return Promise.reject(new Error(`connect ECONNREFUSED ${host}`));
            }
            return Promise.resolve({
                exec: (command: string) => {
                    const [, op = "", nonce = "", ttlRaw] = (command.split("\n")[0] ?? "").split(" ");
                    const ttl = Number(ttlRaw);
                    commands.push({ host, op });
                    const cur = locks.get(host);
                    const fresh = cur !== undefined && cur.expiresAt > clock.now;
                    if (op === "acquire") {
                        if (cannotWrite.has(host)) {
                            return Promise.resolve(lockResult("CANNOT_WRITE /opt/intentic"));
                        }
                        if (!fresh) {
                            locks.set(host, { nonce, expiresAt: clock.now + ttl });
                            return Promise.resolve(lockResult(cur === undefined ? "ACQUIRED" : "TOOKOVER"));
                        }
                        return Promise.resolve(lockResult(`HELD other-run`));
                    }
                    if (op === "verify") {
                        return Promise.resolve(lockResult(cur?.nonce === nonce ? "OK" : `LOST ${cur?.nonce ?? ""}`));
                    }
                    if (op === "renew") {
                        if (cur?.nonce === nonce) {
                            cur.expiresAt = clock.now + ttl;
                        }
                        return Promise.resolve(lockResult(cur?.nonce === nonce ? "OK" : "LOST"));
                    }
                    if (op === "release") {
                        if (cur?.nonce === nonce) {
                            locks.delete(host);
                            return Promise.resolve(lockResult("RELEASED"));
                        }
                        return Promise.resolve(lockResult("SKIP"));
                    }
                    return Promise.resolve(lockResult(""));
                },
                dispose: () => Promise.resolve(),
            });
        },
    };
    return { executor, locks, commands, clock };
};

const target = (address: string, port = 22): SshTarget => ({ address, user: "deploy", privateKey: "k", port });

describe("acquireApplyLock", () => {
    it("acquires a host's lock and releases it, leaving the host unlocked", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        expect(fleet.locks.has("10.0.0.1:22")).toBe(true);
        await lock.release();
        expect(fleet.locks.has("10.0.0.1:22")).toBe(false);
    });

    it("acquires multiple hosts in deterministic (sorted) order regardless of input order", async () => {
        const fleet = createFakeFleet();
        await acquireApplyLock(fleet.executor, [target("10.0.0.3"), target("10.0.0.1"), target("10.0.0.2")]);
        expect(fleet.commands.filter((c) => c.op === "acquire").map((c) => c.host)).toEqual(["10.0.0.1:22", "10.0.0.2:22", "10.0.0.3:22"]);
    });

    it("dedupes the same host:port so it is locked once", async () => {
        const fleet = createFakeFleet();
        await acquireApplyLock(fleet.executor, [target("10.0.0.1"), target("10.0.0.1")]);
        expect(fleet.commands.filter((c) => c.op === "acquire")).toHaveLength(1);
    });

    it("aborts and releases already-held locks when a later host is held by another run", async () => {
        const fleet = createFakeFleet();
        // Host 2 is pre-seeded as held by another live run.
        fleet.locks.set("10.0.0.2:22", { nonce: "other", expiresAt: 999_999 });
        await expect(acquireApplyLock(fleet.executor, [target("10.0.0.1"), target("10.0.0.2")])).rejects.toThrow(
            /another intentic run holds the apply lock on 10\.0\.0\.2:22/,
        );
        // Host 1's lock is released after the abort.
        expect(fleet.locks.has("10.0.0.1:22")).toBe(false);
        // Host 2's foreign lock is untouched.
        expect(fleet.locks.get("10.0.0.2:22")?.nonce).toBe("other");
    });

    it("aborts with a clear, actionable error when the deploy user cannot write /opt/intentic, releasing earlier locks", async () => {
        const fleet = createFakeFleet({ cannotWrite: new Set(["10.0.0.2:22"]) });
        await expect(acquireApplyLock(fleet.executor, [target("10.0.0.1"), target("10.0.0.2")])).rejects.toThrow(
            /cannot create \/opt\/intentic on 10\.0\.0\.2:22/,
        );
        // All-or-abort: host 1's lock is released when host 2 fails.
        expect(fleet.locks.has("10.0.0.1:22")).toBe(false);
    });

    it("skips an unreachable host rather than failing the run", async () => {
        const fleet = createFakeFleet({ unreachable: new Set(["10.0.0.2:22"]) });
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1"), target("10.0.0.2")]);
        expect(fleet.locks.has("10.0.0.1:22")).toBe(true);
        await lock.release();
    });

    it("takes over a stale (expired) lock, then verify confirms ownership", async () => {
        const fleet = createFakeFleet();
        // A crashed run's lock, already expired against the shared clock.
        fleet.locks.set("10.0.0.1:22", { nonce: "crashed", expiresAt: 500 });
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        expect(fleet.locks.get("10.0.0.1:22")?.nonce).not.toBe("crashed");
        await expect(lock.verify()).resolves.toBeUndefined();
    });

    it("verify throws when our lock was taken over (nonce no longer ours)", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        // Another run steals the lock (TTL elapsed).
        fleet.locks.set("10.0.0.1:22", { nonce: "stolen", expiresAt: 999_999 });
        await expect(lock.verify()).rejects.toThrow(/was taken over by another run/);
    });

    it("release only removes a lock that still carries our nonce (never a successor's)", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        fleet.locks.set("10.0.0.1:22", { nonce: "successor", expiresAt: 999_999 });
        await lock.release();
        expect(fleet.locks.get("10.0.0.1:22")?.nonce).toBe("successor");
    });

    it("renew pushes the takeover deadline so a long apply is not stolen", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")], { ttlSeconds: 100 });
        const original = fleet.locks.get("10.0.0.1:22")?.expiresAt ?? 0;
        fleet.clock.now += 50;
        await lock.renew();
        expect(fleet.locks.get("10.0.0.1:22")?.expiresAt).toBeGreaterThan(original);
    });
});

// Waits for a timer-driven condition without betting on how many beats a loaded machine fits into a fixed sleep.
const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
        await Bun.sleep(5);
    }
};

describe("renew and the heartbeat", () => {
    it("renew throws LockLostError once another run holds the lock", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        fleet.locks.set("10.0.0.1:22", { nonce: "stolen", expiresAt: 999_999 });
        await expect(lock.renew()).rejects.toBeInstanceOf(LockLostError);
    });

    it("renews on every beat for as long as the run lasts, then stops", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")], { ttlSeconds: 100 });
        const heartbeat = startLockHeartbeat(lock, { intervalMs: 5, onLost: () => {} });
        await until(() => fleet.commands.filter((c) => c.op === "renew").length >= 2);
        heartbeat.stop();
        const renewals = fleet.commands.filter((c) => c.op === "renew").length;
        expect(renewals).toBeGreaterThanOrEqual(2);
        await Bun.sleep(20);
        expect(fleet.commands.filter((c) => c.op === "renew").length).toBe(renewals);
    });

    it("stops the run at once when the lock is taken over", async () => {
        const fleet = createFakeFleet();
        const lock = await acquireApplyLock(fleet.executor, [target("10.0.0.1")]);
        const lost: Error[] = [];
        const heartbeat = startLockHeartbeat(lock, { intervalMs: 5, onLost: (error) => lost.push(error) });
        fleet.locks.set("10.0.0.1:22", { nonce: "stolen", expiresAt: 999_999 });
        await until(() => lost.length > 0);
        await Bun.sleep(20);
        heartbeat.stop();
        expect(lost).toHaveLength(1);
        expect(lost[0]).toBeInstanceOf(LockLostError);
    });

    it("rides out one failed renewal, and stops the run on a second in a row", async () => {
        let failing = 0;
        const lock: ApplyLock = {
            verify: async () => {},
            release: async () => {},
            ttlSeconds: 100,
            renew: async () => {
                failing += 1;
                if (failing === 1 || failing >= 3) {
                    throw new Error("connect ETIMEDOUT");
                }
            },
        };
        const lost: Error[] = [];
        const heartbeat = startLockHeartbeat(lock, { intervalMs: 5, onLost: (error) => lost.push(error) });
        await until(() => lost.length > 0);
        await Bun.sleep(20);
        heartbeat.stop();
        // Beat 1 failed and beat 2 succeeded (reset), so only beats 3 and 4 in a row stop it.
        expect(lost).toHaveLength(1);
        expect(lost[0]?.message).toContain("could not renew the apply lock twice in a row");
        expect(failing).toBe(4);
    });
});
