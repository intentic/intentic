import type { OpencodeClient } from "@opencode-ai/sdk";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import type { OpenCodeService } from "../opencode/opencode.js";
import { grokAccountDoor, type GrokAccountDeps } from "./grok-accounts.js";

type AuthReply = Awaited<ReturnType<OpencodeClient["provider"]["auth"]>>;
type AuthorizeReply = Awaited<ReturnType<OpencodeClient["provider"]["oauth"]["authorize"]>>;
type CallbackReply = Awaited<ReturnType<OpencodeClient["provider"]["oauth"]["callback"]>>;
type AuthCall = (...args: Parameters<OpencodeClient["provider"]["auth"]>) => Promise<AuthReply>;
type AuthorizeCall = (...args: Parameters<OpencodeClient["provider"]["oauth"]["authorize"]>) => Promise<AuthorizeReply>;
type CallbackCall = (...args: Parameters<OpencodeClient["provider"]["oauth"]["callback"]>) => Promise<CallbackReply>;
type PolledProvider = { auth: AuthCall; oauth: { authorize: AuthorizeCall; callback: CallbackCall } };
const DEVICE_URL = "https://accounts.x.ai/device?user_code=FRESH-CODE";
const authorization = unstubbed<AuthorizeReply>("authorize reply", {
    data: { url: DEVICE_URL, method: "auto", instructions: "STALE-CODE" },
});
const cancelDoors: (() => void)[] = [];

// One SDK seam for these lifecycle tests: pauses and responses are controlled, without a real sign-in or network.
const fakeDoor = () => {
    const auth = jest.fn<AuthCall>().mockResolvedValue(
        unstubbed<AuthReply>("auth reply", {
            data: {
                xai: [
                    { type: "api", label: "API key" },
                    { type: "oauth", label: "Browser login" },
                    { type: "oauth", label: "Headless device login" },
                ],
            },
        }),
    );
    const authorize = jest.fn<AuthorizeCall>().mockResolvedValue(authorization);
    const callback = jest.fn<CallbackCall>().mockResolvedValue(unstubbed<CallbackReply>("pending reply", { data: false }));
    const oauth = { authorize, callback };
    const provider: PolledProvider = {
        auth,
        oauth: unstubbed<typeof oauth>("oauth", oauth),
    };
    const client = unstubbed<OpencodeClient>("client", {
        // SAFETY: these calls use the SDK's default non-throwing response shape. The mock inputs/replies derive from
        // its methods, but Jest cannot preserve the SDK's generic conditional return type for throwOnError.
        provider: unstubbed<typeof provider>("provider", provider) as OpencodeClient["provider"],
    });
    const leases: { calls: number; finished: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
    const acquire = jest.fn<OpenCodeService["acquire"]>().mockImplementation(async () => {
        const lease = { calls: 0, finished: Promise.withResolvers<void>() };
        leases.push(lease);
        return {
            client,
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
    return { door, start, auth, authorize, callback, acquire, leases, pauses, resume, released };
};

afterEach(async () => {
    for (const cancel of cancelDoors.splice(0)) {
        cancel();
    }
    await realYield();
    jest.useRealTimers();
});

test("Grok device sign-in leases xAI through asynchronous setup and polling, using the preferred device method", async () => {
    const fake = fakeDoor();
    const entered = Promise.withResolvers<void>();
    const authorizing = Promise.withResolvers<AuthorizeReply>();
    fake.authorize.mockImplementationOnce(() => {
        entered.resolve();
        return authorizing.promise;
    });
    const started = fake.start();
    await entered.promise;
    expect(fake.acquire).toHaveBeenCalledWith({ providerID: "xai" });
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    authorizing.resolve(authorization);
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
    expect(fake.authorize).toHaveBeenCalledWith({ path: { id: "xai" }, body: { method: 2 } });
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    expect(fake.callback).not.toHaveBeenCalled();
    fake.door.cancel(login.handshake);
    expect(await fake.released(0)).toBe(1);
});

test.each(["methods failed", "no OAuth", "authorization failed", "missing authorization", "invalid URL"])(
    "failed device setup releases its lease: %s",
    async (failure) => {
        const fake = fakeDoor();
        switch (failure) {
            case "methods failed":
                fake.auth.mockRejectedValueOnce(new Error("auth unavailable"));
                break;
            case "no OAuth":
                fake.auth.mockResolvedValueOnce(unstubbed<AuthReply>("no OAuth", { data: { xai: [{ type: "api", label: "API key" }] } }));
                break;
            case "authorization failed":
                fake.authorize.mockRejectedValueOnce(new Error("authorize unavailable"));
                break;
            case "missing authorization":
                fake.authorize.mockResolvedValueOnce(unstubbed<AuthorizeReply>("missing authorization", { data: undefined }));
                break;
            case "invalid URL":
                fake.authorize.mockResolvedValueOnce(
                    unstubbed<AuthorizeReply>("invalid URL", { data: { url: "not a URL", method: "auto", instructions: "code" } }),
                );
                break;
        }
        await expect(fake.start()).rejects.toThrow();
        expect(await fake.released(0)).toBe(1);
        expect(fake.callback).not.toHaveBeenCalled();
        expect(fake.pauses).toEqual([]);
    },
);

test("approval releases the sign-in runtime once, even if the finished handshake is later cancelled", async () => {
    const fake = fakeDoor();
    fake.callback.mockResolvedValueOnce(unstubbed<CallbackReply>("approved reply", { data: true }));
    const login = await fake.start();
    const signal = fake.pauses[0]?.signal;
    fake.resume();
    expect(await fake.released(0)).toBe(1);
    expect(fake.callback).toHaveBeenCalledWith({ path: { id: "xai" }, body: { method: 2 }, signal });
    fake.door.cancel(login.handshake);
    expect(fake.leases.map((lease) => lease.calls)).toEqual([1]);
});

test("a transient callback failure retains the runtime until approval", async () => {
    const fake = fakeDoor();
    const attempted = Promise.withResolvers<void>();
    fake.callback.mockImplementationOnce(async () => {
        attempted.resolve();
        throw new Error("authorization_pending");
    });
    await fake.start();
    fake.resume();
    await attempted.promise;
    await realYield();
    expect(fake.leases.map((lease) => lease.calls)).toEqual([0]);
    fake.callback.mockResolvedValueOnce(unstubbed<CallbackReply>("approved reply", { data: true }));
    fake.resume();
    expect(await fake.released(0)).toBe(1);
    expect(fake.callback).toHaveBeenCalledTimes(2);
});

test("cancellation aborts an in-flight OAuth callback before releasing the runtime", async () => {
    const fake = fakeDoor();
    const entered = Promise.withResolvers<void>();
    fake.callback.mockImplementationOnce((options) => {
        entered.resolve();
        return new Promise<CallbackReply>((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("callback cancelled")), { once: true }),
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
    expect(fake.callback).toHaveBeenCalledTimes(1);
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
    expect(fake.callback).not.toHaveBeenCalled();
});
