import { redeemWhileWarming, type RedeemRetry } from "./pairing-redeem.js";

/* The redeem loop both pairing peers run, over a sandbox the test plays one answer at a time. */

const scripted = (answers: readonly (number | "offline" | "hang")[]) => {
    const tries: number[] = [];
    const send = async (attempt: number, signal: AbortSignal | undefined): Promise<Response> => {
        tries.push(attempt);
        const next = answers[attempt - 1] ?? answers.at(-1) ?? "offline";
        if (next === "offline") {
            throw new TypeError("fetch failed");
        }
        if (next === "hang") {
            return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
        }
        return new Response(`status ${next}`, { status: next });
    };
    return { tries, send };
};

const statusOf = (outcome: Awaited<ReturnType<typeof redeemWhileWarming>>): number | undefined =>
    outcome.kind === "answered" ? outcome.response.status : undefined;

describe("redeemWhileWarming", () => {
    it("answers the first reply below 500 without asking again", async () => {
        const { tries, send } = scripted([200]);
        expect(statusOf(await redeemWhileWarming(send, { attempts: 3, delayMs: 0 }))).toBe(200);
        expect(tries).toEqual([1]);
    });

    it("asks again through a warming sandbox and an unreachable one, saying why each time", async () => {
        const { tries, send } = scripted(["offline", 502, 200]);
        const heard: { attempt: number; why: RedeemRetry["kind"] }[] = [];
        const outcome = await redeemWhileWarming(send, { attempts: 5, delayMs: 0, onRetry: (attempt, why) => heard.push({ attempt, why: why.kind }) });
        expect(statusOf(outcome)).toBe(200);
        expect(tries).toEqual([1, 2, 3]);
        expect(heard).toEqual([
            { attempt: 1, why: "unreachable" },
            { attempt: 2, why: "warming" },
        ]);
    });

    it("hands back a 401 at once: an expired code is an answer, not a blip", async () => {
        const { tries, send } = scripted([401, 200]);
        expect(statusOf(await redeemWhileWarming(send, { attempts: 5, delayMs: 0 }))).toBe(401);
        expect(tries).toEqual([1]);
    });

    it("answers the last 5xx when the sandbox is still warming after every try", async () => {
        const { tries, send } = scripted([503]);
        const heard: number[] = [];
        const outcome = await redeemWhileWarming(send, { attempts: 3, delayMs: 0, onRetry: (attempt) => heard.push(attempt) });
        expect(outcome.kind).toBe("answered");
        expect(outcome.kind === "answered" ? await outcome.response.text() : undefined).toBe("status 503");
        expect(tries).toEqual([1, 2, 3]);
        // The last try is not retried, so it is not narrated as one.
        expect(heard).toEqual([1, 2]);
    });

    it("is unreachable, with the last try's failure, when nothing ever answered", async () => {
        const { tries, send } = scripted(["offline"]);
        const outcome = await redeemWhileWarming(send, { attempts: 2, delayMs: 0 });
        expect(outcome.kind).toBe("unreachable");
        expect(outcome.kind === "unreachable" ? outcome.error : undefined).toBeInstanceOf(TypeError);
        expect(tries).toEqual([1, 2]);
    });

    it("abandons a try that outlives its timeout and asks again", async () => {
        const { tries, send } = scripted(["hang", 200]);
        expect(statusOf(await redeemWhileWarming(send, { attempts: 2, delayMs: 0, timeoutMs: 10 }))).toBe(200);
        expect(tries).toEqual([1, 2]);
    });

    it("rejects with the stop's reason rather than answering when its signal aborts", async () => {
        const stop = new AbortController();
        const { tries, send } = scripted([502]);
        const running = redeemWhileWarming(send, {
            attempts: 5,
            delayMs: 60_000,
            signal: stop.signal,
            onRetry: () => stop.abort(new Error("stopped")),
        });
        await expect(running).rejects.toThrow("stopped");
        expect(tries).toEqual([1]);
    });
});
