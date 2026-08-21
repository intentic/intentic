import { GateVerdictSchema } from "@intentic/sandbox-contract";
import { WAIT_DEFAULT_S } from "@intentic/gate";
import { expect, test } from "vitest";
import { annotationOf, defaultRequest, outputLines, parseInputs, stepExitOf, summaryOf } from "./action.js";

const GATE_URL = "https://box.example/workflows/wf/gate?token=t";
const FIRE_URL = "https://box.example/automations/nightly/fire?token=t";

test("a gate URL and nothing else is a call with the defaults", () => {
    const parsed = parseInputs({ INPUT_URL: GATE_URL });
    expect(parsed).toEqual({
        kind: "inputs",
        inputs: { url: GATE_URL, door: "gate", request: "", waitS: WAIT_DEFAULT_S, blockedAsFailure: false },
    });
});

test("the URL's own path names the door: no mode input to disagree with it", () => {
    const parsed = parseInputs({ INPUT_URL: FIRE_URL });
    expect(parsed.kind === "inputs" && parsed.inputs.door).toBe("fire");
});

test("a tunnel prefix ahead of the route does not hide the door", () => {
    const parsed = parseInputs({ INPUT_URL: "https://tunnel.example/my-box/workflows/wf/gate?token=t" });
    expect(parsed.kind === "inputs" && parsed.inputs.door).toBe("gate");
});

test("no URL, a non-URL, and a URL to neither door are each refused with their own sentence", () => {
    expect(parseInputs({}).kind).toBe("error");
    expect(parseInputs({ INPUT_URL: "not a url" }).kind).toBe("error");
    expect(parseInputs({ INPUT_URL: "https://box.example/webchat/wf/message" }).kind).toBe("error");
});

test("wait and blocked-as land where they say, and junk in either is refused", () => {
    const parsed = parseInputs({ INPUT_URL: GATE_URL, INPUT_WAIT: "300", "INPUT_BLOCKED-AS": "failure" });
    expect(parsed.kind === "inputs" && parsed.inputs.waitS).toBe(300);
    expect(parsed.kind === "inputs" && parsed.inputs.blockedAsFailure).toBe(true);
    expect(parseInputs({ INPUT_URL: GATE_URL, INPUT_WAIT: "soon" }).kind).toBe("error");
    expect(parseInputs({ INPUT_URL: GATE_URL, INPUT_WAIT: "0" }).kind).toBe("error");
    expect(parseInputs({ INPUT_URL: GATE_URL, "INPUT_BLOCKED-AS": "neutral" }).kind).toBe("error");
});

test("the default request is the commit, the branch, and the link a reviewer would want", () => {
    const env = {
        GITHUB_SHA: "abc123",
        GITHUB_REF_NAME: "main",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/app",
    };
    expect(defaultRequest(env, undefined)).toBe("commit abc123 on main — https://github.com/acme/app/commit/abc123");
    // A pull request's page beats the bare commit's when the event carries one.
    expect(defaultRequest(env, { pull_request: { html_url: "https://github.com/acme/app/pull/7" } })).toBe(
        "commit abc123 on main — https://github.com/acme/app/pull/7",
    );
    // Outside a runner there is nothing to compose from: empty, which the process refuses before spending a run.
    expect(defaultRequest({}, undefined)).toBe("");
});

/* Every value goes out in the heredoc form, because a reason is a model's own sentence: the one test that
 * matters here is that a multi-line reason survives the runner's parser. Held against the contract's schema
 * like gate's reader is, so a field the wire shape grows cannot be silently dropped half-written. */
test("outputs serialize schema-valid verdicts whole, multi-line reasons included", () => {
    const verdict = { outcome: "fail" as const, reason: "line one\nline two", runId: "run-9", value: "almost" };
    expect(GateVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(outputLines(verdict, "D")).toBe("outcome<<D\nfail\nD\nreason<<D\nline one\nline two\nD\nrun-id<<D\nrun-9\nD\nvalue<<D\nalmost\nD\n");
    // No judged value ⇒ no value line, rather than an empty one pretending the workflow produced "".
    expect(outputLines({ outcome: "pass", reason: "r", runId: "run-1" }, "D")).not.toContain("value");
});

test("the summary carries the verdict, its reason and the run id", () => {
    const summary = summaryOf({ outcome: "blocked", reason: '"Judge" failed.', runId: "run-3" });
    expect(summary).toContain("blocked");
    expect(summary).toContain('"Judge" failed.');
    expect(summary).toContain("run-3");
});

test("fail annotates as error, blocked follows the setting, pass stays quiet: payload escaped", () => {
    const of = (outcome: "pass" | "fail" | "blocked", blockedAsFailure: boolean) =>
        annotationOf({ outcome, reason: "50% done\nnot yet", runId: "r" }, blockedAsFailure);
    expect(of("pass", false)).toBeUndefined();
    expect(of("fail", false)).toBe("::error::fail: 50%25 done%0Anot yet");
    expect(of("blocked", false)).toBe("::warning::blocked: 50%25 done%0Anot yet");
    expect(of("blocked", true)).toBe("::error::blocked: 50%25 done%0Anot yet");
});

test("the step's exit is the CLI's: pass 0, fail 1, blocked per the setting", () => {
    const of = (outcome: "pass" | "fail" | "blocked", blockedAsFailure: boolean) => stepExitOf({ outcome, reason: "", runId: "r" }, blockedAsFailure);
    expect(of("pass", true)).toBe(0);
    expect(of("fail", false)).toBe(1);
    expect(of("blocked", false)).toBe(0);
    expect(of("blocked", true)).toBe(1);
});
