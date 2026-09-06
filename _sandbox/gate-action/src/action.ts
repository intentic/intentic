/* THE ACTION'S DECISIONS, AS PURE FUNCTIONS, what @intentic/gate's gate.ts is to its CLI, this is to the
 * GitHub Action: everything the step decides, separated from the process that acts on it, so a workflow's
 * exact behaviour is asserted in tests rather than discovered in somebody's merge queue.
 *
 * ONE ACTION, TWO DOORS AND THE API. The daemon serves two routes a CI system can call with a door URL, the
 * release gate (/workflows/:id/gate), which holds the connection and answers a verdict, and the event
 * automation's webhook (/automations/:id/fire), which wakes the agent and answers immediately. The URL the user
 * pasted already says which one it is, so the action reads the path instead of asking for a mode input that
 * could disagree with it. The third way in is not a door: with a control token (`token`, minted on Sandbox →
 * Access) the step drives the agent at the sandbox's own address, starting a turn with a `prompt` and waiting
 * for it to settle (@intentic/gate's run.ts). The token is what selects that road: a door URL needs none.
 *
 * WHY THE RUNNER PROTOCOL IS SPOKEN BY HAND. A step's whole interface to the runner is environment variables
 * in (INPUT_*) and appended files out (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) plus `::error::` lines on stdout.
 * That is a few dozen lines, and @actions/core would be the only dependency in a closure that is otherwise
 * @intentic/gate's zero, bundled into the dist every workflow downloads, for nothing the tests here don't
 * already pin. */

import { exitOf, exitOfRun, type GateVerdict, type RunOutcome, WAIT_DEFAULT_S } from "@intentic/gate";

export type Door = "gate" | "fire" | "run";

export interface ActionInputs {
    readonly url: string;
    readonly door: Door;
    // What to tell the agent, verbatim. Empty means the process composes the default for the door: the
    // commit/branch/PR line for a gate, the workflow's event payload for an automation. The run door's prompt.
    readonly request: string;
    readonly waitS: number;
    // A `blocked` verdict fails the step only when asked. Success by default: "the check could not judge" is
    // not "the product is broken", and a gate that goes red for its own outages stops being believed.
    readonly blockedAsFailure: boolean;
    // The run door's credential and settings; absent on the two door URLs, which carry their own token.
    readonly token?: string;
    readonly agent?: string;
    readonly land: boolean;
}

export type ParsedInputs = { kind: "inputs"; inputs: ActionInputs } | { kind: "error"; message: string };

/* Which door the URL names, read from the END of the path: the daemon may sit behind a tunnel or proxy that
 * prefixes segments, but the two routes it serves are the last things in their paths by construction. */
const doorOf = (path: string): Door | undefined => {
    const segments = path.split("/").filter((segment) => segment !== "");
    const [route, , tail] = segments.slice(-3);
    if (route === "workflows" && tail === "gate") {
        return "gate";
    }
    return route === "automations" && tail === "fire" ? "fire" : undefined;
};

/* Which road the inputs name. A token means the API: the URL is then the sandbox's address and must not be a
 * door, because a door carries its own credential and a token beside it is a wiring mistake worth naming
 * rather than guessing at. No token means a door, read off the end of the path. */
const roadOf = (url: string, token: string): { readonly door: Door; readonly token?: string } | { readonly error: string } => {
    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        return { error: "the url input is not a URL, paste the door URL exactly as the sandbox hands it out" };
    }
    const door = doorOf(path);
    if (token === "") {
        return door === undefined
            ? { error: "the url is neither a release gate (…/workflows/<id>/gate) nor an automation webhook (…/automations/<id>/fire); to drive the agent directly, add `with: token`" }
            : { door };
    }
    return door === undefined
        ? { door: "run", token }
        : { error: "a door URL carries its own token: use `with: url` alone for a gate or a webhook, or point `url` at the sandbox's own address to drive the agent with `token`" };
};

// The runner hands a boolean input over as text; anything but the two words is refused rather than read as false.
const landOf = (raw: string): boolean | { readonly error: string } =>
    raw === "" || raw === "false" ? false : raw === "true" ? true : { error: `land is "true" or "false", not "${raw}"` };

// The one non-empty setting a run needs beyond the road: what to say. The two doors compose theirs.
const settingsOf = (env: Readonly<Record<string, string | undefined>>, door: Door): { readonly request: string; readonly agent?: string; readonly land: boolean } | { readonly error: string } => {
    const request = door === "run" ? (env["INPUT_PROMPT"] ?? "") : (env["INPUT_REQUEST"] ?? "");
    if (door === "run" && request === "") {
        return { error: "nothing to tell the agent: set `with: prompt` for a run" };
    }
    const land = landOf(env["INPUT_LAND"] ?? "");
    if (typeof land !== "boolean") {
        return land;
    }
    const agent = env["INPUT_AGENT"] ?? "";
    return { request, ...(agent === "" ? {} : { agent }), land };
};

// The runner uppercases an input's name and prefixes INPUT_, `blocked-as` arrives as INPUT_BLOCKED-AS.
export const parseInputs = (env: Readonly<Record<string, string | undefined>>): ParsedInputs => {
    const url = env["INPUT_URL"] ?? "";
    if (url === "") {
        return { kind: "error", message: "no url: point `with: url` at a door URL from your sandbox (stored as a repository secret), or at the sandbox's address with `token`" };
    }
    const road = roadOf(url, env["INPUT_TOKEN"] ?? "");
    if ("error" in road) {
        return { kind: "error", message: road.error };
    }
    const waitS = waitOf(env["INPUT_WAIT"] ?? "");
    if (typeof waitS !== "number") {
        return { kind: "error", message: waitS.error };
    }
    const blockedAsFailure = blockedOf(env["INPUT_BLOCKED-AS"] ?? "");
    if (typeof blockedAsFailure !== "boolean") {
        return { kind: "error", message: blockedAsFailure.error };
    }
    const settings = settingsOf(env, road.door);
    if ("error" in settings) {
        return { kind: "error", message: settings.error };
    }
    return { kind: "inputs", inputs: { url, ...road, waitS, blockedAsFailure, ...settings } };
};

// A whole positive number of seconds, or the sentence refusing what was written; empty is the default.
const waitOf = (raw: string): number | { readonly error: string } => {
    const waitS = raw === "" ? WAIT_DEFAULT_S : Number(raw);
    return Number.isInteger(waitS) && waitS > 0 ? waitS : { error: `wait needs a whole number of seconds, not "${raw}"` };
};

const blockedOf = (raw: string): boolean | { readonly error: string } =>
    raw === "" || raw === "success" ? false : raw === "failure" ? true : { error: `blocked-as is "success" or "failure", not "${raw}"` };

/* The gate's default request, what this workflow knows without being told: the commit, the branch, and the
 * link a reviewer would want, which is the pull request when the event carries one and the commit page
 * otherwise. Built from the runner's own variables so the copyable snippet stays one `uses:` line instead of
 * re-templating `${{ github.sha }}` into every workflow file. Empty when there is no context to compose from
 * (running outside a runner), which the caller refuses before spending a run on it. */
export const defaultRequest = (env: Readonly<Record<string, string | undefined>>, event: unknown): string => {
    const sha = env["GITHUB_SHA"] ?? "";
    if (sha === "") {
        return "";
    }
    const parts = [`commit ${sha}`];
    const branch = env["GITHUB_REF_NAME"] ?? "";
    if (branch !== "") {
        parts.push(`on ${branch}`);
    }
    const pullRequest = (event as { pull_request?: { html_url?: unknown } } | undefined)?.pull_request?.html_url;
    const repository = env["GITHUB_REPOSITORY"] ?? "";
    const server = env["GITHUB_SERVER_URL"] ?? "";
    if (typeof pullRequest === "string") {
        parts.push(`— ${pullRequest}`);
    } else if (repository !== "" && server !== "") {
        parts.push(`— ${server}/${repository}/commit/${sha}`);
    }
    return parts.join(" ");
};

/* GITHUB_OUTPUT lines for the verdict, every value in the runner's heredoc form: a reason is a model's own
 * sentence and may hold anything, and one serialization for all four fields beats a "simple enough for =" test
 * that would eventually be wrong. The delimiter is the caller's (a UUID per invocation), so a value cannot
 * contain it. */
export const outputLines = (verdict: GateVerdict, delimiter: string): string => {
    const entries: [string, string][] = [
        ["outcome", verdict.outcome],
        ["reason", verdict.reason],
        ["run-id", verdict.runId],
        ...(verdict.value === undefined ? [] : ([["value", verdict.value]] as [string, string][])),
    ];
    return entries.map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`).join("");
};

// The step summary, the verdict where a person will actually read it, above the fold of the run page.
export const summaryOf = (verdict: GateVerdict): string =>
    `### Intentic gate: ${verdict.outcome}\n\n${verdict.reason}\n\nRun \`${verdict.runId}\` holds the full transcript in the sandbox.\n`;

// A workflow-command's payload survives only with the runner's own escaping (%, CR, LF, in that order).
const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/* The annotation the verdict earns: fail is an error whatever the settings, blocked is an error only when the
 * step is set to fail on it and a warning otherwise, visible either way, because "the check could not judge"
 * is exactly the line someone scans a green run for after an incident. Pass earns none; the summary carries it. */
export const annotationOf = (verdict: GateVerdict, blockedAsFailure: boolean): string | undefined => {
    if (verdict.outcome === "pass") {
        return undefined;
    }
    const severity = verdict.outcome === "fail" || blockedAsFailure ? "error" : "warning";
    return `::${severity}::${escapeData(`${verdict.outcome}: ${verdict.reason}`)}`;
};

// The step's exit is the CLI's: pass 0, fail 1, blocked per the setting, one mapping, imported not repeated.
export const stepExitOf = (verdict: GateVerdict, blockedAsFailure: boolean): number => exitOf(verdict, blockedAsFailure ? 1 : 0);

// ---- the run door's half of the runner protocol ----

/* GITHUB_OUTPUT lines for a run's ending, in the same heredoc form as a verdict's and for the same reason: a
 * summary is a model's own sentence. `landed` only when a land was asked for, so a workflow that did not ask
 * cannot read a "false" as a refusal. */
export const runOutputLines = (outcome: RunOutcome, delimiter: string): string => {
    const entries: [string, string][] = [
        ["status", outcome.status],
        ["conversation-id", outcome.conversationId],
        ...(outcome.branch === undefined ? [] : ([["branch", outcome.branch]] as [string, string][])),
        ["summary", outcome.summary],
        ...(outcome.landed === undefined ? [] : ([["landed", String(outcome.landed)]] as [string, string][])),
    ];
    return entries.map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`).join("");
};

export const runSummaryOf = (outcome: RunOutcome): string =>
    `### Intentic agent: ${outcome.status}\n\n${outcome.summary}\n\nConversation \`${outcome.conversationId}\`${outcome.branch === undefined ? "" : ` on branch \`${outcome.branch}\``}${
        outcome.landed === undefined ? "" : outcome.landed ? ", landed into the main tree." : ", not landed."
    }\n`;

/* The annotation a run's ending earns. Failed is an error; parked is a warning, because the product is not
 * broken, a person is being asked for something; a timeout is an error about the WIRING (the deadline, not the
 * work, decided) and says the agent is still going. Completed earns none; the summary carries it. */
export const runAnnotationOf = (outcome: RunOutcome): string | undefined => {
    if (outcome.status === "completed") {
        return undefined;
    }
    const severity = outcome.status === "parked" ? "warning" : "error";
    return `::${severity}::${escapeData(`${outcome.status}: ${outcome.summary}`)}`;
};

export const runStepExitOf = (outcome: RunOutcome): number => exitOfRun(outcome.status);
