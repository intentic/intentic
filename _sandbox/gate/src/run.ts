// Starts an agent turn with a control token, polls until it settles, and maps the ending to an exit code. Three calls:
// POST /agent starts it, GET /agents/{id} is polled (survives a dropped connection where streaming would not), POST
// /agents/{id}/land merges. Zero dependencies, so readers are checked by hand against run.test.ts's contract schemas.

export const RUN_WAIT_DEFAULT_S = 1800;
// How often the card is polled for settlement; five seconds is invisible against a turn that runs minutes.
export const RUN_POLL_MS = 5_000;

export interface RunCall {
    // The sandbox's own address, e.g. https://sandbox-….intentic.dev, no path.
    readonly origin: string;
    readonly token: string;
    readonly prompt: string;
    // The conversation the turn opens or continues; a re-run of the same CI job continues its own by default.
    readonly conversationId: string;
    // Which agent runs it (claude, codex, …); absent takes the sandbox's default.
    readonly agent?: string;
    readonly waitS: number;
    // Merge the branch into the main tree when the turn completes; needs a land-scoped token.
    readonly land: boolean;
}

export type RunStatus = "completed" | "parked" | "failed" | "timeout";

export interface RunOutcome {
    readonly status: RunStatus;
    readonly conversationId: string;
    // The branch the isolated turn worked on, agent/<conversationId>; absent for a turn that never began.
    readonly branch?: string;
    // The card's own account: what it was called, the sentence it failed on, or which card it parked on.
    readonly summary: string;
    // Whether the land was applied whole; absent when none was asked for or the turn did not complete.
    readonly landed?: boolean;
}

// The body POST /agent takes (AgentTurnSchema, the fields a CI caller may set).
export const runRequestBody = (call: RunCall): Record<string, unknown> => ({
    prompt: call.prompt,
    conversationId: call.conversationId,
    // Its own worktree and branch: CI work never lands in the shared tree by itself.
    isolated: true,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
});

// One conversation per workflow run and attempt, so a re-run continues it and two jobs of one run do not collide;
// outside a runner, a random id.
export const conversationIdFor = (env: Readonly<Record<string, string | undefined>>, random: () => string): string => {
    const runId = env["GITHUB_RUN_ID"] ?? "";
    if (runId === "") {
        return `ci-${random()
            .replaceAll(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 24)}`;
    }
    const attempt = env["GITHUB_RUN_ATTEMPT"] ?? "1";
    return `ci-${runId}-${attempt}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
};

// The agent card as this reads it (AgentSummarySchema's status, title, failure, branch, attention).
export interface AgentCard {
    readonly status: string;
    readonly title?: string;
    readonly failure?: string;
    readonly branch?: string;
    readonly attention?: Readonly<Record<string, boolean>>;
}

// Undefined means the body was not a card at all (a proxy's error page), an exchange failure.
export const readCard = (body: unknown): AgentCard | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const { status, title, failure, branch, attention } = body as Record<string, unknown>;
    if (typeof status !== "string") {
        return undefined;
    }
    return {
        status,
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof failure === "string" ? { failure } : {}),
        ...(typeof branch === "string" ? { branch } : {}),
        ...(typeof attention === "object" && attention !== null ? { attention: attention as Record<string, boolean> } : {}),
    };
};

// Statuses under which the turn is still doing something; anything else is a settled card.
const IN_FLIGHT = new Set(["running", "stopping", "dismissing", "resuming"]);

// `awaiting` settles as parked: a pipeline cannot answer a card waiting on a person, so this ends the step rather than
// stall until the job's own timeout does. Other terminal statuses: failed (error, interrupted, conflict) or completed.
export const settledOf = (card: AgentCard): RunStatus | undefined => {
    if (IN_FLIGHT.has(card.status)) {
        return undefined;
    }
    if (card.status === "awaiting") {
        return "parked";
    }
    return card.status === "error" || card.status === "interrupted" || card.status === "conflict" ? "failed" : "completed";
};

// What the card asked for, named, so the step's message says which card a person has to open.
const PARKED_ON: readonly (readonly [string, string])[] = [
    ["plan", "a plan waiting for approval"],
    ["question", "a question"],
    ["permission", "a permission request"],
    ["capability", "something to be connected"],
    ["credential", "a gated credential"],
];

export const summaryOfCard = (card: AgentCard, status: RunStatus): string => {
    if (status === "parked") {
        const on = PARKED_ON.find(([key]) => card.attention?.[key] === true)?.[1] ?? "a card only a person can answer";
        return `The agent is parked on ${on}: open the conversation in the sandbox to answer it.`;
    }
    if (status === "failed") {
        return card.failure ?? `The turn ended with status "${card.status}".`;
    }
    return card.title ?? "The agent finished.";
};

// done 0; parked/failed 1 (needs a person); timeout 2 (deadline decided, not the work, which keeps running).
export const exitOfRun = (status: RunStatus): number => (status === "completed" ? 0 : status === "timeout" ? 2 : 1);

// The CLI's own argument shape: `intentic-gate run …`.

export type ParsedRun = { kind: "call"; call: RunCall } | { kind: "help" } | { kind: "error"; message: string };

export const RUN_USAGE = `intentic-gate run: start an agent turn in your sandbox and exit on how it ended

usage: intentic-gate run [options] [prompt...]

The prompt is the arguments joined, or stdin when none are given.

options:
  --url <origin>       the sandbox's own address (or env INTENTIC_URL)
  --token <ict_…>      a control token minted on Sandbox → Access (or env INTENTIC_TOKEN); drive scope, or
                       land scope with --land
  --agent <name>       which agent runs it (claude, codex, …); default: the sandbox's own
  --conversation <id>  the conversation to open or continue; default: one per CI run
  --wait <seconds>     how long to wait for the turn to settle (default ${RUN_WAIT_DEFAULT_S})
  --land               merge the branch into the main tree once the turn completes
  -h, --help           this text

exit codes:  0 completed · 1 parked on a person, or failed · 2 the exchange itself failed, or the turn
was still running at the deadline (it keeps working in the sandbox).`;

// Options that take a value, scanned by name so the parser is a table and a loop rather than a ladder.
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--url", "--token", "--agent", "--conversation", "--wait"]);

interface ScannedRun {
    readonly help: boolean;
    readonly land: boolean;
    readonly values: ReadonlyMap<string, string>;
    readonly words: readonly string[];
    readonly error?: string;
}

const scanRunArgs = (argv: readonly string[]): ScannedRun => {
    const values = new Map<string, string>();
    const words: string[] = [];
    let land = false;
    for (let at = 0; at < argv.length; at += 1) {
        const arg = argv[at] as string;
        if (arg === "-h" || arg === "--help") {
            return { help: true, land, values, words };
        }
        if (arg === "--land") {
            land = true;
        } else if (VALUE_OPTIONS.has(arg)) {
            const value = argv[at + 1];
            if (value === undefined) {
                return { help: false, land, values, words, error: `${arg} needs a value` };
            }
            values.set(arg, value);
            at += 1;
        } else if (arg.startsWith("--")) {
            return { help: false, land, values, words, error: `unknown option ${arg}` };
        } else {
            words.push(arg);
        }
    }
    return { help: false, land, values, words };
};

// A whole number of seconds, or the sentence refusing what was written.
const waitOf = (raw: string | undefined): number | { readonly error: string } => {
    if (raw === undefined) {
        return RUN_WAIT_DEFAULT_S;
    }
    const numeric = Number(raw);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : { error: `--wait needs a whole number, not "${raw}"` };
};

// Where and as whom: the option first, the environment second, and the sentence naming which one is missing.
const addressOf = (
    scanned: ScannedRun,
    env: Readonly<Record<string, string | undefined>>,
): { readonly origin: string; readonly token: string } | { readonly error: string } => {
    const url = scanned.values.get("--url") ?? env["INTENTIC_URL"] ?? "";
    const token = scanned.values.get("--token") ?? env["INTENTIC_TOKEN"] ?? "";
    if (url === "") {
        return { error: "no sandbox URL: pass --url or set INTENTIC_URL" };
    }
    if (token === "") {
        return { error: "no control token: pass --token or set INTENTIC_TOKEN (minted on Sandbox → Access → API tokens)" };
    }
    const origin = originOf(url);
    return origin === undefined ? { error: `the URL is not a sandbox address: ${url}` } : { origin, token };
};

export const parseRunArgs = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>, random: () => string): ParsedRun => {
    const scanned = scanRunArgs(argv);
    if (scanned.error !== undefined) {
        return { kind: "error", message: scanned.error };
    }
    if (scanned.help) {
        return { kind: "help" };
    }
    const address = addressOf(scanned, env);
    if ("error" in address) {
        return { kind: "error", message: address.error };
    }
    const waitS = waitOf(scanned.values.get("--wait"));
    if (typeof waitS !== "number") {
        return { kind: "error", message: waitS.error };
    }
    const agent = scanned.values.get("--agent");
    return {
        kind: "call",
        call: {
            ...address,
            prompt: scanned.words.join(" "),
            conversationId: scanned.values.get("--conversation") ?? conversationIdFor(env, random),
            ...(agent === undefined ? {} : { agent }),
            waitS,
            land: scanned.land,
        },
    };
};

// The sandbox's origin alone: a pasted address with a stray path or slash still names the same daemon.
export const originOf = (url: string): string | undefined => {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
};

// The exchange itself, with its effects injected so both the CLI and the action share it, and a test can drive it.

export interface RunDeps {
    readonly fetch: (
        url: string,
        init: { method: string; headers: Record<string, string>; body?: string },
    ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
}

// Something other than an ending: the wiring failed (a refused token, an unreachable sandbox, a body that was not a
// card). Reported with the daemon's own sentence when it had one.
export class RunExchangeError extends Error {}

// The daemon's own sentence when it has one, the raw body when it does not (a proxy or tunnel answered). Exported so
// the GitHub Action reads the same failures the same way.
export const detailOf = (text: string): string => {
    try {
        const body = JSON.parse(text) as { error?: unknown };
        return typeof body.error === "string" ? body.error : text;
    } catch {
        return text;
    }
};

const headersFor = (call: RunCall): Record<string, string> => ({ "x-intentic-control": call.token, "content-type": "application/json" });

const answerOf = async (
    deps: RunDeps,
    what: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
): Promise<unknown> => {
    const response = await deps.fetch(url, init).catch((error: unknown) => {
        throw new RunExchangeError(`${what} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    });
    const text = await response.text();
    if (!response.ok) {
        // 403 on the land is the one refusal with a fix a person can read straight off: the token's scope.
        const hint = response.status === 403 && what === "the land" ? " (the token needs land scope)" : "";
        throw new RunExchangeError(`${what} answered ${response.status}: ${detailOf(text)}${hint}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new RunExchangeError(`${what}'s answer was not JSON: ${text.slice(0, 200)}`);
    }
};

// Starts the turn, waits for the card to settle, lands if asked. Throws RunExchangeError for anything but an ending of
// the agent's own; even a timeout comes back as an outcome.
export const runExchange = async (call: RunCall, deps: RunDeps): Promise<RunOutcome> => {
    const cardUrl = `${call.origin}/agents/${encodeURIComponent(call.conversationId)}`;
    await answerOf(deps, "the agent", `${call.origin}/agent`, {
        method: "POST",
        headers: headersFor(call),
        body: JSON.stringify(runRequestBody(call)),
    });
    const deadline = deps.now() + call.waitS * 1_000;
    let card: AgentCard | undefined;
    let status: RunStatus | undefined;
    while (status === undefined) {
        await deps.sleep(RUN_POLL_MS);
        card = readCard(await answerOf(deps, "the agent card", cardUrl, { method: "GET", headers: headersFor(call) }));
        if (card === undefined) {
            throw new RunExchangeError("the agent card could not be read");
        }
        status = settledOf(card);
        if (status === undefined && deps.now() >= deadline) {
            status = "timeout";
        }
    }
    const branch = card?.branch ?? `agent/${call.conversationId}`;
    const outcome: RunOutcome = {
        status,
        conversationId: call.conversationId,
        branch,
        summary:
            status === "timeout" ? `Still running after ${call.waitS}s; it keeps working in the sandbox.` : summaryOfCard(card as AgentCard, status),
    };
    if (!call.land || status !== "completed") {
        return outcome;
    }
    const landed = (await answerOf(deps, "the land", `${cardUrl}/land`, { method: "POST", headers: headersFor(call), body: "{}" })) as {
        landed?: unknown;
    };
    return { ...outcome, landed: landed.landed === true };
};
