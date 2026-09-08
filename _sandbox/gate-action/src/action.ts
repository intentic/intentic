// Pure decision functions for the GitHub Action, separated from what acts on them, so a workflow's behaviour is
// asserted in tests, not discovered in a merge queue.
// Two doors read from the URL's own path (gate holds and answers a verdict, fire wakes and answers at once); a control
// token instead selects a third road that drives the agent directly at the sandbox's address.
// The runner protocol (env vars in, output files and `::error::` lines out) is spoken by hand rather than pulling in
// @actions/core for a few dozen lines.

import { exitOf, exitOfRun, type GateVerdict, type RunOutcome, WAIT_DEFAULT_S } from "@intentic/gate";

export type Door = "gate" | "fire" | "run";

export interface ActionInputs {
    readonly url: string;
    readonly door: Door;
    // Verbatim message to the agent; empty composes the door's default (commit/branch/PR, or the event payload).
    readonly request: string;
    readonly waitS: number;
    // A `blocked` verdict fails the step only when asked; a judge that can't judge isn't a broken product.
    readonly blockedAsFailure: boolean;
    // Run door's credential and settings; absent on the two door URLs, which carry their own token.
    readonly token?: string;
    readonly agent?: string;
    readonly land: boolean;
}

export type ParsedInputs = { kind: "inputs"; inputs: ActionInputs } | { kind: "error"; message: string };

// Door named from the end of the path, since a tunnel or proxy may prefix segments but never follow the route.
const doorOf = (path: string): Door | undefined => {
    const segments = path.split("/").filter((segment) => segment !== "");
    const [route, , tail] = segments.slice(-3);
    if (route === "workflows" && tail === "gate") {
        return "gate";
    }
    return route === "automations" && tail === "fire" ? "fire" : undefined;
};

// A token means the API: the URL is then the sandbox's address, and must not also be a door (a door carries its own
// credential).
// No token means a door, read off the end of the path.
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

// Runner hands a boolean input as text; anything but the two words is refused rather than read as false.
const landOf = (raw: string): boolean | { readonly error: string } =>
    raw === "" || raw === "false" ? false : raw === "true" ? true : { error: `land is "true" or "false", not "${raw}"` };

// The one non-empty setting a run needs beyond the road: what to say; the two doors compose theirs instead.
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

// Runner uppercases an input name and prefixes INPUT_; `blocked-as` arrives as INPUT_BLOCKED-AS.
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

// Whole positive number of seconds, or the sentence refusing what was written; empty is the default.
const waitOf = (raw: string): number | { readonly error: string } => {
    const waitS = raw === "" ? WAIT_DEFAULT_S : Number(raw);
    return Number.isInteger(waitS) && waitS > 0 ? waitS : { error: `wait needs a whole number of seconds, not "${raw}"` };
};

const blockedOf = (raw: string): boolean | { readonly error: string } =>
    raw === "" || raw === "success" ? false : raw === "failure" ? true : { error: `blocked-as is "success" or "failure", not "${raw}"` };

// Default request built from the runner's own variables (commit, branch, PR link when there is one), so the copyable
// snippet stays one `uses:` line.
// Empty outside a runner, which the caller refuses before spending a run on it.
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

// GITHUB_OUTPUT lines in the runner's heredoc form, since a reason is a model's own sentence that may hold anything.
// The delimiter is a UUID per call, so a value can never contain it.
export const outputLines = (verdict: GateVerdict, delimiter: string): string => {
    const entries: [string, string][] = [
        ["outcome", verdict.outcome],
        ["reason", verdict.reason],
        ["run-id", verdict.runId],
        ...(verdict.value === undefined ? [] : ([["value", verdict.value]] as [string, string][])),
    ];
    return entries.map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`).join("");
};

// Step summary: the verdict where a person actually reads it, above the fold of the run page.
export const summaryOf = (verdict: GateVerdict): string =>
    `### Intentic gate: ${verdict.outcome}\n\n${verdict.reason}\n\nRun \`${verdict.runId}\` holds the full transcript in the sandbox.\n`;

// Workflow-command payload escaping, in the runner's own order: %, then CR, then LF.
const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// Fail is always an error; blocked is an error only when the step is set to fail on it, a warning otherwise, but always
// visible.
// Pass earns no annotation; the summary carries it.
export const annotationOf = (verdict: GateVerdict, blockedAsFailure: boolean): string | undefined => {
    if (verdict.outcome === "pass") {
        return undefined;
    }
    const severity = verdict.outcome === "fail" || blockedAsFailure ? "error" : "warning";
    return `::${severity}::${escapeData(`${verdict.outcome}: ${verdict.reason}`)}`;
};

// Step exit mirrors the CLI's mapping (pass 0, fail 1, blocked per setting), imported rather than repeated.
export const stepExitOf = (verdict: GateVerdict, blockedAsFailure: boolean): number => exitOf(verdict, blockedAsFailure ? 1 : 0);

// The run door's half of the runner protocol.

// GITHUB_OUTPUT lines for a run's ending, same heredoc form as a verdict's, since a summary is also a model's own
// sentence.
// `landed` appears only when a land was asked for, so an unasked workflow can't read a false as a refusal.
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

// Failed is an error; parked is a warning, since the product isn't broken and a person is being asked something; a
// timeout is an error about the wiring, since the deadline decided, not the work.
// Completed earns no annotation; the summary carries it.
export const runAnnotationOf = (outcome: RunOutcome): string | undefined => {
    if (outcome.status === "completed") {
        return undefined;
    }
    const severity = outcome.status === "parked" ? "warning" : "error";
    return `::${severity}::${escapeData(`${outcome.status}: ${outcome.summary}`)}`;
};

export const runStepExitOf = (outcome: RunOutcome): number => exitOfRun(outcome.status);
