import { redeemPairing } from "./enroll.js";

// The enroll door against scripted answers, one per attempt: what the popup is told depends on which refusal the
// sandbox gave, and a 5xx is a sandbox still starting, never an expired code.

const PAIRING = { url: "https://sandbox-abc.example.dev/", token: "pair-1" };

const scripted = (answers: readonly (Response | "offline")[]) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const answer = answers[Math.min(calls.length, answers.length) - 1];
        if (answer === undefined || answer === "offline") {
            throw new TypeError("Failed to fetch");
        }
        return answer;
    }) as typeof fetch;
    return { calls, options: { fetch: send, sleep: async () => {}, attempts: 3 } };
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a redeemed code answers the durable token, posting the pairing token to the enroll door", async () => {
    const { calls, options } = scripted([json(200, { id: "brave", token: "durable" })]);
    expect(await redeemPairing(PAIRING, options)).toEqual({ kind: "enrolled", token: "durable" });
    expect(calls.map(({ url }) => url)).toEqual(["https://sandbox-abc.example.dev/system/webext/enroll"]);
    expect(calls[0]?.init).toEqual({ method: "POST", headers: { "x-intentic-pair": "pair-1" } });
});

test("a 502 from a sandbox warming up is retried, and redeems once it is up", async () => {
    const { calls, options } = scripted([json(502, {}), "offline", json(200, { id: "brave", token: "durable" })]);
    expect(await redeemPairing(PAIRING, options)).toEqual({ kind: "enrolled", token: "durable" });
    expect(calls).toHaveLength(3);
});

test("a sandbox still answering 5xx after every attempt is starting, not an expired code", async () => {
    const { calls, options } = scripted([json(502, {}), json(503, {}), json(502, {})]);
    expect(await redeemPairing(PAIRING, options)).toEqual({ kind: "starting", status: 502 });
    expect(calls).toHaveLength(3);
});

test("only a 401 is an expired code, and it is final", async () => {
    const { calls, options } = scripted([json(401, { error: "pairing expired" })]);
    expect(await redeemPairing(PAIRING, options)).toEqual({ kind: "expired" });
    expect(calls).toHaveLength(1);
});

test("another 4xx is reported with its status", async () => {
    expect(await redeemPairing(PAIRING, scripted([json(403, {})]).options)).toEqual({ kind: "refused", status: 403 });
});

test("no answer at all is unreachable", async () => {
    expect(await redeemPairing(PAIRING, scripted(["offline"]).options)).toEqual({ kind: "unreachable" });
});

test("a 200 that is not an enrollment answer is unreadable rather than a token", async () => {
    expect(await redeemPairing(PAIRING, scripted([json(200, { token: 7 })]).options)).toEqual({ kind: "unreadable" });
    expect(await redeemPairing(PAIRING, scripted([new Response("<html>", { status: 200 })]).options)).toEqual({ kind: "unreadable" });
});
