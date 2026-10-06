import { EventEmitter } from "node:events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";

// A platform that accepts the connection but never answers: the response callback is never invoked. The fake
// mirrors the two ClientRequest behaviors the timeout path relies on: setTimeout arms an idle timer, and
// destroy(err) surfaces that error via the `error` event.
const requestMock = jest.fn((_url: URL, _opts: unknown, _cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        setTimeout: (ms: number, cb: () => void) => void;
        destroy: (err: Error) => void;
    };
    req.end = () => {};
    req.setTimeout = (ms, cb) => void setTimeout(cb, ms);
    req.destroy = (err) => void req.emit("error", err);
    return req;
});
jest.mock("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { callIngress } = await import("./platform-client.js");

const config = {
    platform: { url: "https://host.docker.internal:6480" },
    connectToken: "tok",
} as unknown as Parameters<typeof callIngress>[0];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("callIngress", () => {
    it("rejects when the platform accepts the socket but never responds", async () => {
        // The rejection is held here rather than asserted before the advance: `expect(...).rejects` blocks until the
        // promise settles, and only the advance below settles it.
        const failure = callIngress(config, { route: "localDns", input: { challenge: "x" }, idleMs: 60_000 }).then(
            () => undefined,
            (error: Error) => error,
        );
        await advanceTimersByTimeAsync(60_000);
        expect((await failure)?.message).toMatch(/respond in time/);
    });
});

// A platform that answers `status` with `body`, recording what each request was: its URL, its options and its payload.
const answering = (status: number, body: string) => {
    const sent: { url: string; method: unknown; headers: Record<string, string>; payload: string | undefined }[] = [];
    requestMock.mockImplementation((url: URL, opts: unknown, cb: (res: unknown) => void) => {
        const options = opts as { method: unknown; headers: Record<string, string> };
        const req = new EventEmitter() as EventEmitter & { end: (payload?: string) => void; setTimeout: () => void; destroy: () => void };
        req.setTimeout = () => {};
        req.destroy = () => {};
        req.end = (payload) => {
            sent.push({ url: url.toString(), method: options.method, headers: options.headers, payload });
            const res = Object.assign(new EventEmitter(), { statusCode: status, headers: { "content-type": "application/json" } });
            cb(res);
            res.emit("data", Buffer.from(body));
            res.emit("end");
        };
        return req;
    });
    return sent;
};

describe("callIngress against a platform that answers", () => {
    afterEach(() => requestMock.mockReset());

    it("sends the contract's method, path and connect-token header, and the body as JSON", async () => {
        const sent = answering(200, `{"ok":true,"identity":"db-1"}`);
        const answer = await callIngress(config, { route: "announce", input: { daemonUrl: "https://abc123def456.intentic.dev", version: "1.2.3" } });
        expect(sent).toEqual([
            {
                url: "https://host.docker.internal:6480/sandbox/announce",
                method: "POST",
                headers: { "x-intentic-connect": "tok", "content-type": "application/json" },
                payload: `{"daemonUrl":"https://abc123def456.intentic.dev","version":"1.2.3"}`,
            },
        ]);
        expect(answer).toEqual({ status: 200, data: { ok: true, identity: "db-1" }, refusal: undefined, body: `{"ok":true,"identity":"db-1"}` });
    });

    it("presents a provisioning token as a bearer, and sends no body on a GET", async () => {
        const sent = answering(200, `{"email":"o@example.com","label":"agent"}`);
        const answer = await callIngress(config, { route: "fleetWhoami", bearer: "prov" });
        expect(sent).toEqual([
            { url: "https://host.docker.internal:6480/fleet/whoami", method: "GET", headers: { authorization: "Bearer prov" }, payload: undefined },
        ]);
        expect(answer.data).toEqual({ email: "o@example.com", label: "agent" });
    });

    it("reads a refusal as today's platform spells it, and as an older one did", async () => {
        answering(404, `{"error":"unknown sandbox"}`);
        expect(await callIngress(config, { route: "bootReport", input: { reach: "reachable" } })).toMatchObject({ status: 404, refusal: "unknown sandbox" });
        answering(410, "error: this sandbox was deleted");
        expect(await callIngress(config, { route: "announce", input: { daemonUrl: "https://abc123def456.intentic.dev" } })).toMatchObject({
            status: 410,
            data: undefined,
            refusal: "this sandbox was deleted",
        });
    });

    it("reads an older platform's bare 200 as a success with only what it said", async () => {
        answering(200, `{"ok":true}`);
        expect((await callIngress(config, { route: "announce", input: { daemonUrl: "https://abc123def456.intentic.dev" } })).data).toEqual({ ok: true });
        answering(200, "ok");
        expect(await callIngress(config, { route: "localDnsConfirm", input: { challenge: "x" } })).toMatchObject({ status: 200, data: undefined, refusal: undefined });
    });
});
