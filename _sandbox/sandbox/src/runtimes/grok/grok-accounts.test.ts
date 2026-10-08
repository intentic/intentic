import type { OpenCodeClient } from "@opencode/client";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import type { OpenCodeService } from "../opencode/opencode.js";
import { grokAccountDoor, type GrokAccountDeps } from "./grok-accounts.js";

type Integration = OpenCodeClient["integration"];
type ConnectCall = Integration["oauth"]["connect"];
type StatusCall = Integration["oauth"]["status"];
type CancelCall = Integration["oauth"]["cancel"];
type GetCall = Integration["get"];
type ConnectReply = Awaited<ReturnType<ConnectCall>>;
type StatusReply = Awaited<ReturnType<StatusCall>>;
const DEVICE_URL = "https://accounts.x.ai/oauth2/device?user_code=FRESH-CODE";
const ATTEMPT = "con_attempt";
// As OpenCode 2.0.26 answers a device sign-in's start: the attempt, the pre-filled URL, and how long xAI allows.
const attempt = (expires = Date.now() + 30 * 60_000): ConnectReply =>
    unstubbed<ConnectReply>("connect reply", {
        data: { attemptID: ATTEMPT, url: DEVICE_URL, instructions: "Enter code: STALE-CODE", mode: "auto", time: { created: Date.now(), expires } },
    });
const statusOf = (status: "pending" | "complete" | "failed" | "expired"): StatusReply =>
    unstubbed<StatusReply>("status reply", { data: { status, time: { created: 0, expires: 0 } } } as never);
const cancelDoors: (() => void)[] = [];

// One client seam for these lifecycle tests: pauses and responses are controlled, without a real sign-in or network.
const fakeDoor = () => {
    const get = jest.fn<GetCall>().mockResolvedValue(unstubbed<Awaited<ReturnType<GetCall>>>("integration", {}));
    const connect = jest.fn<ConnectCall>().mockImplementation(async () => attempt());
    const status = jest.fn<StatusCall>().mockResolvedValue(statusOf("pending"));
    const cancel = jest.fn<CancelCall>().mockResolvedValue(undefined);
    const oauth = { connect, status, cancel };
    // SAFETY: the sign-in uses only these integration calls; each mock derives from the client's own method types.
    const client = unstubbed<OpenCodeClient>("client", {
        integration: unstubbed<Integration>("integration", { get, oauth: unstubbed<Integration["oauth"]>("oauth", oauth) }),
    });
    const leases: { calls: number; finished: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
    const acquire = jest.fn<OpenCodeService["acquire"]>().mockImplementation(async () => {
        const lease = { calls: 0, finished: Promise.withResolvers<void>() };
        leases.push(lease);
        return {
            client,
            listen: () => () => {},
            release: () => {
                lease.calls += 1;
                lease.finished.resolve();
            },
        };
    });
    const pauses: { signal: AbortSignal; resume: () => void }[] = [];
    const pause = (signal: AbortSignal): Promise<void> => {
        const waiting = Promise.withResolvers<void>();
        const abort = (): void => waiting.reject(new Error("poll cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
            abort();
        }
        pauses.push({ signal, resume: waiting.resolve });
        return waiting.promise.finally(() => signal.removeEventListener("abort", abort));
    };
    const door = grokAccountDoor(
        unstubbed<GrokAccountDeps>("services", {
            openCode: unstubbed<OpenCodeService>("openCode", { acquire }),
        }),
        { pause },
    );
    const handshakes: string[] = [];
    const start = async () => {
        const login = await door.start(undefined);
        handshakes.push(login.handshake);
        return login;
    };
    cancelDoors.push(() => {
        for (const handshake of handshakes) {
            door.cancel(handshake);
        }
    });
    const resume = (): void => {
        const waiting = pauses.shift();
        if (waiting === undefined) {
            throw new Error("the sign-in has not reached its poll pause");
        }
        waiting.resume();
    };
    const released = async (index: number): Promise<number> => {
        const lease = leases[index];
        if (lease === undefined) {
            throw new Error("the sign-in did not acquire its runtime");
        }
        await lease.finished.promise;
        return lease.calls;
    };
    return { door, start, get, connect, status, cancel, acquire, leases, pauses, resume, released };
};

afterEach(async () => {
    for (const cancel of cancelDoors.splice(0)) {
        cancel();
    }
    await realYield();
    jest.useRealTimers();
});

test("Grok device sign-in leases xAI through asynchronous setup and polling, using xAI's device method", async () => {
    const fake = fakeDoor();
    const entered = Promise.withResolvers<void>();
    const connecting = Promise.withResolvers<ConnectReply>();
    fake.connect.mockImplementationOnce(() => {
        entered.resolve();
        return connecting.promise;
    });
    const started = fake.start();
    await entered.promise;
    expect(fake.acquire).toHaveBeenCalledWith({ providerID: "xai" });
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    connecting.resolve(attempt());
    const login = await started;
    expect(login).toEqual({
        url: DEVICE_URL,
        code: "FRESH-CODE",
        state: "",
        flow: "device",
        variant: "",
        handshake: expect.any(String),
        expiresAt: expect.any(Number),
    });
    expect(fake.connect).toHaveBeenCalledWith({ integrationID: "xai", methodID: "device" });
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    expect(fake.status).not.toHaveBeenCalled();
    fake.door.cancel(login.handshake);
    expect(await fake.released(0)).toBe(1);
    // A sign-in given up on is cancelled at OpenCode too, which stops it polling xAI for nothing.
    expect(fake.cancel).toHaveBeenCalledWith({ integrationID: "xai", attemptID: ATTEMPT });
});

// OpenCode loads its integration catalog just after it starts listening, and answers until then that xAI is unknown.
test("a sign-in started while OpenCode is still loading its catalog waits for xAI to appear", async () => {
    const fake = fakeDoor();
    fake.get.mockRejectedValueOnce(Object.assign(new Error("Integration not found: xai"), { name: "IntegrationNotFoundError" }));
    const login = await fake.start();
    expect(login.code).toBe("FRESH-CODE");
    expect(fake.get).toHaveBeenCalledTimes(2);
});

test.each(["catalog failed", "connect failed", "invalid URL"])("failed device setup releases its lease: %s", async (failure) => {
    const fake = fakeDoor();
    switch (failure) {
        case "catalog failed":
            fake.get.mockRejectedValueOnce(new Error("integration unavailable"));
            break;
        case "connect failed":
            fake.connect.mockRejectedValueOnce(new Error("connect unavailable"));
            break;
        case "invalid URL":
            fake.connect.mockResolvedValueOnce(
                unstubbed<ConnectReply>("invalid URL", {
                    data: { attemptID: ATTEMPT, url: "not a URL", instructions: "code", mode: "auto", time: { created: 0, expires: Date.now() + 60_000 } },
                }),
            );
            break;
    }
    await expect(fake.start()).rejects.toThrow();
    expect(await fake.released(0)).toBe(1);
    expect(fake.status).not.toHaveBeenCalled();
    expect(fake.pauses).toEqual([]);
});

test("approval releases the sign-in runtime once, even if the finished handshake is later cancelled", async () => {
    const fake = fakeDoor();
    fake.status.mockResolvedValueOnce(statusOf("complete"));
    const login = await fake.start();
    const signal = fake.pauses[0]?.signal;
    fake.resume();
    expect(await fake.released(0)).toBe(1);
    expect(fake.status).toHaveBeenCalledWith({ integrationID: "xai", attemptID: ATTEMPT }, { signal });
    // A finished attempt is OpenCode's to forget; nothing is cancelled.
    expect(fake.cancel).not.toHaveBeenCalled();
    fake.door.cancel(login.handshake);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([1]);
});

test("a sign-in OpenCode reports failed or expired ends the poll and releases the runtime", async () => {
    for (const ending of ["failed", "expired"] as const) {
        const fake = fakeDoor();
        fake.status.mockResolvedValueOnce(statusOf(ending));
        await fake.start();
        fake.resume();
        expect(await fake.released(0)).toBe(1);
        expect(fake.status).toHaveBeenCalledTimes(1);
    }
});

test("an attempt OpenCode no longer knows ends the poll rather than retrying it for ever", async () => {
    const fake = fakeDoor();
    fake.status.mockRejectedValueOnce(Object.assign(new Error("OAuth attempt not found"), { name: "IntegrationAttemptNotFoundError" }));
    await fake.start();
    fake.resume();
    expect(await fake.released(0)).toBe(1);
});

test("a transient status failure retains the runtime until approval", async () => {
    const fake = fakeDoor();
    const attempted = Promise.withResolvers<void>();
    fake.status.mockImplementationOnce(async () => {
        attempted.resolve();
        throw new Error("socket hang up");
    });
    await fake.start();
    fake.resume();
    await attempted.promise;
    await realYield();
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    fake.status.mockResolvedValueOnce(statusOf("complete"));
    fake.resume();
    expect(await fake.released(0)).toBe(1);
    expect(fake.status).toHaveBeenCalledTimes(2);
});

test("cancellation aborts an in-flight status read before releasing the runtime", async () => {
    const fake = fakeDoor();
    const entered = Promise.withResolvers<void>();
    fake.status.mockImplementationOnce((_input, options) => {
        entered.resolve();
        return new Promise<StatusReply>((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("status cancelled")), { once: true }),
        );
    });
    const login = await fake.start();
    const signal = fake.pauses[0]?.signal;
    fake.resume();
    await entered.promise;
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    fake.door.cancel(login.handshake);
    expect(await fake.released(0)).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(fake.status).toHaveBeenCalledTimes(1);
});

test("superseding a sign-in releases only its old lease and cannot clear the new handshake", async () => {
    const fake = fakeDoor();
    const first = await fake.start();
    const oldSignal = fake.pauses[0]?.signal;
    const second = await fake.start();
    expect(second.handshake).not.toBe(first.handshake);
    expect(await fake.released(0)).toBe(1);
    expect(oldSignal?.aborted).toBe(true);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([1, 0]);
    fake.door.cancel(first.handshake);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([1, 0]);
    fake.door.cancel(second.handshake);
    expect(await fake.released(1)).toBe(1);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([1, 1]);
});

test("device approval expiry aborts the poll and releases its runtime at the fifteen-minute boundary", async () => {
    jest.useFakeTimers();
    const beganAt = Date.now();
    const fake = fakeDoor();
    const login = await fake.start();
    const signal = fake.pauses[0]?.signal;
    expect(login.expiresAt).toBe(beganAt + 15 * 60_000);
    await advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    expect(signal?.aborted).toBe(false);
    await advanceTimersByTimeAsync(1);
    expect(await fake.released(0)).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(fake.status).not.toHaveBeenCalled();
});

// xAI's own window for the code can be shorter than ours; the sign-in ends with it, not after.
test("a device code xAI allows less time than fifteen minutes expires when xAI's does", async () => {
    jest.useFakeTimers();
    const fake = fakeDoor();
    fake.connect.mockImplementationOnce(async () => attempt(Date.now() + 5 * 60_000));
    const login = await fake.start();
    expect(login.expiresAt).toBe(Date.now() + 5 * 60_000);
    await advanceTimersByTimeAsync(5 * 60_000);
    expect(await fake.released(0)).toBe(1);
});
