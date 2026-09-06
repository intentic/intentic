/* THE GATE CALL, AS PURE FUNCTIONS, everything the CLI decides, separated from the process that acts on it,
 * so a pipeline's exact behaviour is asserted in tests rather than discovered in somebody's merge queue.
 *
 * WHY THIS PACKAGE HAS NO DEPENDENCIES. Its whole job is one HTTP POST and an exit code, and it runs cold in
 * CI, `npx @intentic/gate` on a runner that has never seen it. Every dependency is install time on every
 * pipeline of every team that wires a gate, spent before the first byte reaches the daemon. The verdict it
 * reads is three fields; validating them by hand costs twelve lines, and a test (gate.test.ts) holds those
 * lines against the contract package's own schema so they cannot drift. */

// The verdict the daemon answers with (sandbox-contract's GateVerdictSchema, kept in step by test).
export interface GateVerdict {
    readonly outcome: "pass" | "fail" | "blocked";
    readonly reason: string;
    readonly runId: string;
    readonly value?: string;
}

export interface GateCall {
    readonly url: string;
    // How long the gate holds the connection, in seconds. The route caps whatever is asked at three hours.
    readonly waitS: number;
    // The exit for `blocked`. 0 by default: "the check could not judge" is not "the product is broken", and a
    // gate that goes red for its own outages is a gate that stops being believed. Teams whose CI can carry a
    // neutral state (GitLab's allow_failure exit_codes) point this at their own number.
    readonly blockedExit: number;
    // What the pipeline knows, POSTed as the run's request. Empty is refused by the daemon (400): a run with
    // nothing to judge would spend a whole graph of sessions discovering that.
    readonly request: string;
}

export type Parsed = { kind: "call"; call: GateCall } | { kind: "help" } | { kind: "error"; message: string };

export const WAIT_DEFAULT_S = 1800;

export const USAGE = `intentic-gate: run an intentic release gate and exit on its verdict

usage: intentic-gate [options] [request...]

The request, what this pipeline knows: commit, branch, preview URL, is the arguments joined,
or stdin when none are given (so \`git log -1 | intentic-gate\` works).

options:
  --url <url>       the gate's webhook URL, token and all (or env INTENTIC_GATE_URL)
  --wait <seconds>  how long the gate holds the connection (default ${WAIT_DEFAULT_S}; the server caps at 3h)
  --blocked <code>  exit code for a blocked verdict (default 0: "could not judge" is not a failed build)
  -h, --help        this text

exit codes:  0 pass (and blocked, unless --blocked says otherwise) · 1 fail · 2 the exchange itself
failed, wrong token, no such gate, daily ceiling reached, network. 2 is never a verdict: it means
the pipeline's wiring needs a person, not that the product does.`;

export const parseArgs = (argv: readonly string[], envUrl: string | undefined): Parsed => {
    let url = envUrl;
    let waitS = WAIT_DEFAULT_S;
    let blockedExit = 0;
    const words: string[] = [];
    for (let at = 0; at < argv.length; at += 1) {
        const arg = argv[at] as string;
        if (arg === "-h" || arg === "--help") {
            return { kind: "help" };
        }
        if (arg === "--url" || arg === "--wait" || arg === "--blocked") {
            const value = argv[at + 1];
            if (value === undefined) {
                return { kind: "error", message: `${arg} needs a value` };
            }
            at += 1;
            if (arg === "--url") {
                url = value;
                continue;
            }
            const numeric = Number(value);
            if (!Number.isInteger(numeric) || numeric < 0) {
                return { kind: "error", message: `${arg} needs a whole number, not "${value}"` };
            }
            if (arg === "--wait") {
                waitS = numeric;
            } else {
                blockedExit = numeric;
            }
            continue;
        }
        if (arg.startsWith("--")) {
            return { kind: "error", message: `unknown option ${arg}` };
        }
        words.push(arg);
    }
    if (url === undefined || url === "") {
        return { kind: "error", message: "no gate URL: pass --url or set INTENTIC_GATE_URL" };
    }
    return { kind: "call", call: { url, waitS, blockedExit, request: words.join(" ") } };
};

/* THE URL AS ACTUALLY DIALLED, and the headers that go with it. The door URL a sandbox hands out carries its
 * token as `?token=`, the one shape a webhook sender can carry; this caller can set a header, so the token is
 * lifted out of the query and sent as `authorization: Bearer …` instead, and the URL that reaches the edge, the
 * tunnel and every proxy's log between here and the daemon names the door and nothing else. The caller's own
 * deadline rides as a query parameter (`wait`) when it has one; a fire has none. Through the URL API rather
 * than string glue, so a URL that already carries parameters is extended, not corrupted. */
export interface Dial {
    readonly url: string;
    readonly headers: Record<string, string>;
}

export const dialOf = (url: string, waitS?: number): Dial => {
    const target = new URL(url);
    const token = target.searchParams.get("token");
    target.searchParams.delete("token");
    if (waitS !== undefined) {
        target.searchParams.set("wait", String(waitS));
    }
    return { url: target.toString(), headers: token === null || token === "" ? {} : { authorization: `Bearer ${token}` } };
};

// How long the HTTP client itself waits: a minute past the gate's own hold, so the deadline that fires is
// the server's, which STOPS the run, and not the client's, which would abandon it mid-spend.
export const clientTimeoutMs = (waitS: number): number => (waitS + 60) * 1_000;

const OUTCOMES = new Set(["pass", "fail", "blocked"]);

// The daemon's answer, checked by hand (see the header for why not a schema dependency). Undefined means the
// body was not a verdict at all, a proxy's error page, a truncated read, which is an exchange failure.
export const readVerdict = (body: unknown): GateVerdict | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const { outcome, reason, runId, value } = body as Record<string, unknown>;
    if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || typeof reason !== "string" || typeof runId !== "string") {
        return undefined;
    }
    return {
        outcome: outcome as GateVerdict["outcome"],
        reason,
        runId,
        ...(typeof value === "string" ? { value } : {}),
    };
};

export const exitOf = (verdict: GateVerdict, blockedExit: number): number => {
    if (verdict.outcome === "pass") {
        return 0;
    }
    return verdict.outcome === "fail" ? 1 : blockedExit;
};

// The run door, the API reached with a control token rather than a door URL, shares this package for the
// reason above: one zero-dependency install for every way a pipeline talks to a sandbox.
export * from "./run.js";
