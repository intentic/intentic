import { errorMessage } from "@intentic/base/errors";
import { detailOf } from "./run.js";

// What the CLI decides and the one exchange it makes, kept separate from the process that acts on them. No schema
// library: this runs cold under `npx` in CI, so verdict fields are checked by hand and pinned to the contract schema by
// gate.test.ts.

// The verdict the daemon answers with (sandbox-contract's GateVerdictSchema, kept in step by a test).
export interface GateVerdict {
    readonly outcome: "pass" | "fail" | "blocked";
    readonly reason: string;
    readonly runId: string;
    readonly value?: string;
}

export interface GateCall {
    readonly url: string;
    // How long the gate holds the connection, in seconds; the route caps whatever is asked at three hours.
    readonly waitS: number;
    // Default exit for a blocked verdict is 0: blocked means the check could not judge, not a broken build.
    readonly blockedExit: number;
    // What the pipeline knows, POSTed as the run's request; empty is refused by the daemon (400).
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

// The door URL's `?token=` becomes an `authorization: Bearer` header; `waitS` becomes the `wait` query param, added via
// the URL API so existing params survive.
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

// A minute past the gate's own hold, so a timing-out server ends the run rather than an abandoning client.
export const clientTimeoutMs = (waitS: number): number => (waitS + 60) * 1_000;

const OUTCOMES = new Set(["pass", "fail", "blocked"]);

// Validated by hand instead of a schema dependency. Undefined means the body was not a verdict at all (a proxy's error
// page, a truncated read), an exchange failure.
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

// Something other than a verdict: the gate could not be reached, refused the call, or answered with something that was
// not a verdict. Its message is the sentence the CLI and the action print before exiting 2.
export class GateExchangeError extends Error {}

// The exchange's one effect, injected as runExchange's are, so a test can play the gate.
export interface GateDeps {
    readonly fetch: (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
    ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

// POSTs what the pipeline knows and holds the connection until the gate judges it. The CLI and the GitHub Action both
// go through here, so a refusal reads the same in either; anything but a verdict throws GateExchangeError.
export const gateExchange = async ({ url, waitS, request }: Pick<GateCall, "url" | "waitS" | "request">, deps: GateDeps): Promise<GateVerdict> => {
    // The body is read inside the same catch: the verdict arrives as the body, so a connection cut while the gate holds
    // it is an unreachable gate too, not a crash a pipeline would read as exit 1.
    const reached = async (): Promise<{ ok: boolean; status: number; text: string }> => {
        const dial = dialOf(url, waitS);
        const response = await deps.fetch(dial.url, {
            method: "POST",
            headers: dial.headers,
            body: request,
            signal: AbortSignal.timeout(clientTimeoutMs(waitS)),
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
    };
    let answer: { ok: boolean; status: number; text: string };
    try {
        answer = await reached();
    } catch (error) {
        throw new GateExchangeError(`the gate could not be reached: ${errorMessage(error)}`);
    }
    const { ok, status, text } = answer;
    if (!ok) {
        throw new GateExchangeError(`the gate answered ${status}: ${detailOf(text)}`);
    }
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        body = undefined;
    }
    const verdict = readVerdict(body);
    if (verdict === undefined) {
        throw new GateExchangeError(`the gate's answer was not a verdict: ${text.slice(0, 200)}`);
    }
    return verdict;
};

// The run door shares this package: one small install for every way a pipeline talks to a sandbox.
export * from "./run.js";
