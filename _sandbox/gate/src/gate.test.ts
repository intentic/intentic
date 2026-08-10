import { GateVerdictSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { clientTimeoutMs, exitOf, parseArgs, readVerdict, targetOf, WAIT_DEFAULT_S } from "./gate.js";

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
    expect(targetOf("https://box.example/workflows/wf/gate?token=t", 300)).toBe("https://box.example/workflows/wf/gate?token=t&wait=300");
});

// The client must outlast the server's hold, so the deadline that fires is the daemon's — which stops the
// run — and never the client's, which would abandon it mid-spend.
test("the HTTP timeout is a minute past the gate's own hold", () => {
    expect(clientTimeoutMs(1800)).toBe(1860 * 1_000);
});

/* THE HAND VALIDATOR AGAINST THE CONTRACT — the one test that pays for this package having no dependencies.
 * Whatever GateVerdictSchema accepts, readVerdict must accept; if the wire shape ever moves, this is the
 * build that goes red instead of somebody's pipeline going blind. */
test("readVerdict agrees with the contract's own schema", () => {
    const verdicts = [
        { outcome: "pass", reason: "verdict is \"pass\".", runId: "run-1", value: "pass" },
        { outcome: "fail", reason: "verdict is \"almost\".", runId: "run-2", value: "almost" },
        { outcome: "blocked", reason: "\"Judge\" failed.", runId: "run-3" },
    ];
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
    const of = (outcome: "pass" | "fail" | "blocked", blockedExit: number) =>
        exitOf({ outcome, reason: "", runId: "r" }, blockedExit);
    expect(of("pass", 3)).toBe(0);
    expect(of("fail", 3)).toBe(1);
    expect(of("blocked", 0)).toBe(0);
    expect(of("blocked", 3)).toBe(3);
});
