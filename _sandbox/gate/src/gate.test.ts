import { type GateVerdict, GateVerdictSchema } from "@intentic/sandbox-contract";
import { clientTimeoutMs, dialOf, exitOf, GateExchangeError, gateExchange, type GateDeps, parseArgs, readVerdict, WAIT_DEFAULT_S } from "./gate.js";

test("a URL, some words, and nothing else is a call with the defaults", () => {
    const parsed = parseArgs(["--url", "https://box.example/workflows/wf/gate?token=t", "commit", "abc123"], undefined);
    expect(parsed).toEqual({
        kind: "call",
        call: { url: "https://box.example/workflows/wf/gate?token=t", waitS: WAIT_DEFAULT_S, blockedExit: 0, request: "commit abc123" },
    });
});

test("the URL falls back to the environment, which is where a CI secret arrives", () => {
    const parsed = parseArgs(["hello"], "https://box.example/workflows/wf/gate?token=t");
    expect(parsed.kind).toBe("call");
    expect(parsed.kind === "call" && parsed.call.url).toBe("https://box.example/workflows/wf/gate?token=t");
});

test("no URL from anywhere is an error, not a hang", () => {
    expect(parseArgs(["hello"], undefined).kind).toBe("error");
    expect(parseArgs([], "").kind).toBe("error");
});

test("options that need values refuse to run without them", () => {
    expect(parseArgs(["--url"], undefined).kind).toBe("error");
    expect(parseArgs(["--wait", "soon", "--url", "u"], undefined).kind).toBe("error");
    expect(parseArgs(["--blocked", "-1", "--url", "u"], undefined).kind).toBe("error");
    expect(parseArgs(["--frobnicate", "--url", "u"], undefined).kind).toBe("error");
});

test("wait and blocked land where they say", () => {
    const parsed = parseArgs(["--url", "https://u.example/g?token=t", "--wait", "300", "--blocked", "3"], undefined);
    expect(parsed.kind === "call" && parsed.call.waitS).toBe(300);
    expect(parsed.kind === "call" && parsed.call.blockedExit).toBe(3);
});

test("the wait rides beside the token without corrupting the URL", () => {
    // The token leaves the URL for the header, so the address that reaches every log names the door alone.
    expect(dialOf("https://box.example/workflows/wf/gate?token=t", 300)).toEqual({
        url: "https://box.example/workflows/wf/gate?wait=300",
        headers: { authorization: "Bearer t" },
    });
    // A fire has no deadline, and a URL with no token sends no header rather than an empty one.
    expect(dialOf("https://box.example/automations/a/fire?token=t")).toEqual({
        url: "https://box.example/automations/a/fire",
        headers: { authorization: "Bearer t" },
    });
    expect(dialOf("https://box.example/automations/a/fire")).toEqual({ url: "https://box.example/automations/a/fire", headers: {} });
});

// The client must outlast the server's hold, so the deadline that fires is the daemon's, which stops the
// run, and never the client's, which would abandon it mid-spend.
test("the HTTP timeout is a minute past the gate's own hold", () => {
    expect(clientTimeoutMs(1800)).toBe(1860 * 1_000);
});

/* THE HAND VALIDATOR AGAINST THE CONTRACT: the one test that pays for this package having no dependencies. */
test("readVerdict agrees with the contract's own schema", () => {
    const verdicts = [
        { outcome: "pass", reason: 'verdict is "pass".', runId: "run-1", value: "pass" },
        { outcome: "fail", reason: 'verdict is "almost".', runId: "run-2", value: "almost" },
        { outcome: "blocked", reason: '"Judge" failed.', runId: "run-3" },
    ] satisfies GateVerdict[];
    for (const verdict of verdicts) {
        expect(GateVerdictSchema.safeParse(verdict).success).toBe(true);
        expect(readVerdict(verdict)).toEqual(verdict);
    }
    for (const notAVerdict of [undefined, null, "pass", { outcome: "shipped", reason: "r", runId: "x" }, { outcome: "pass" }]) {
        expect(GateVerdictSchema.safeParse(notAVerdict).success).toBe(false);
        expect(readVerdict(notAVerdict)).toBeUndefined();
    }
});

test("the exit is the verdict: pass 0, fail 1, blocked whatever was asked for", () => {
    const of = (outcome: "pass" | "fail" | "blocked", blockedExit: number) => exitOf({ outcome, reason: "", runId: "r" }, blockedExit);
    expect(of("pass", 3)).toBe(0);
    expect(of("fail", 3)).toBe(1);
    expect(of("blocked", 0)).toBe(0);
    expect(of("blocked", 3)).toBe(3);
});

// A gate that answers `status` with `body`, recording what it was asked.
const gateAnswering = (status: number, body: string): GateDeps & { asked: Array<{ url: string; headers: Record<string, string>; body: string }> } => {
    const asked: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    return {
        asked,
        fetch: async (url, init) => {
            asked.push({ url, headers: init.headers, body: init.body });
            return { ok: status >= 200 && status < 300, status, text: async () => body };
        },
    };
};

const CALL = { url: "https://box.example/workflows/wf/gate?token=t", waitS: 60, request: "commit abc123" };

test("the exchange posts the request with the token as a bearer and answers the verdict", async () => {
    const gate = gateAnswering(200, JSON.stringify({ outcome: "fail", reason: "checkout 500s", runId: "run-1" }));
    expect(await gateExchange(CALL, gate)).toEqual({ outcome: "fail", reason: "checkout 500s", runId: "run-1" });
    expect(gate.asked).toEqual([
        { url: "https://box.example/workflows/wf/gate?wait=60", headers: { authorization: "Bearer t" }, body: "commit abc123" },
    ]);
});

// Every way the wiring breaks is one error with the sentence the CLI and the action print, never a verdict.
test("a refusal, a body that is not a verdict and an unreachable gate each throw the exchange's own error", async () => {
    await expect(gateExchange(CALL, gateAnswering(403, JSON.stringify({ error: "bad token" })))).rejects.toThrow(
        new GateExchangeError("the gate answered 403: bad token"),
    );
    await expect(gateExchange(CALL, gateAnswering(502, "<html>Bad Gateway</html>"))).rejects.toThrow(
        "the gate answered 502: <html>Bad Gateway</html>",
    );
    await expect(gateExchange(CALL, gateAnswering(200, '{"ok":true}'))).rejects.toThrow(`the gate's answer was not a verdict: {"ok":true}`);
    const cut: GateDeps = {
        fetch: async () => ({
            ok: true,
            status: 200,
            text: async () => {
                throw new TypeError("terminated");
            },
        }),
    };
    // A connection cut while the gate holds it is the wiring's failure (exit 2), not a crash a pipeline reads as exit 1.
    await expect(gateExchange(CALL, cut)).rejects.toBeInstanceOf(GateExchangeError);
    await expect(gateExchange(CALL, cut)).rejects.toThrow("the gate could not be reached: terminated");
    await expect(gateExchange({ ...CALL, url: "not a url" }, gateAnswering(200, ""))).rejects.toBeInstanceOf(GateExchangeError);
});
