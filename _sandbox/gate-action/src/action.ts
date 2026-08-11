/* THE ACTION'S DECISIONS, AS PURE FUNCTIONS — what @intentic/gate's gate.ts is to its CLI, this is to the
 * GitHub Action: everything the step decides, separated from the process that acts on it, so a workflow's
 * exact behaviour is asserted in tests rather than discovered in somebody's merge queue.
 *
 * ONE ACTION, TWO DOORS. The daemon serves two routes a CI system can call — the release gate
 * (/workflows/:id/gate), which holds the connection and answers a verdict, and the event automation's webhook
 * (/automations/:id/fire), which wakes the agent and answers immediately. The URL the user pasted already says
 * which one it is, so the action reads the path instead of asking for a mode input that could disagree with it.
 *
 * WHY THE RUNNER PROTOCOL IS SPOKEN BY HAND. A step's whole interface to the runner is environment variables
 * in (INPUT_*) and appended files out (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) plus `::error::` lines on stdout.
 * That is a few dozen lines, and @actions/core would be the only dependency in a closure that is otherwise
 * @intentic/gate's zero — bundled into the dist every workflow downloads, for nothing the tests here don't
 * already pin. */

import { exitOf, type GateVerdict, WAIT_DEFAULT_S } from "@intentic/gate";

export type Door = "gate" | "fire";

export interface ActionInputs {
    readonly url: string;
    readonly door: Door;
    // What to tell the agent, verbatim. Empty means the process composes the default for the door: the
    // commit/branch/PR line for a gate, the workflow's event payload for an automation.
    readonly request: string;
    readonly waitS: number;
    // A `blocked` verdict fails the step only when asked. Success by default: "the check could not judge" is
    // not "the product is broken", and a gate that goes red for its own outages stops being believed.
    readonly blockedAsFailure: boolean;
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

// The runner uppercases an input's name and prefixes INPUT_ — `blocked-as` arrives as INPUT_BLOCKED-AS.
export const parseInputs = (env: Readonly<Record<string, string | undefined>>): ParsedInputs => {
    const url = env["INPUT_URL"] ?? "";
    if (url === "") {
        return { kind: "error", message: "no url: point `with: url` at a door URL from your sandbox, stored as a repository secret" };
    }
    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        return { kind: "error", message: "the url input is not a URL — paste the door URL exactly as the sandbox hands it out" };
    }
    const door = doorOf(path);
    if (door === undefined) {
        return {
            kind: "error",
            message: "the url is neither a release gate (…/workflows/<id>/gate) nor an automation webhook (…/automations/<id>/fire)",
        };
    }
    const rawWait = env["INPUT_WAIT"] ?? "";
    const waitS = rawWait === "" ? WAIT_DEFAULT_S : Number(rawWait);
    if (!Number.isInteger(waitS) || waitS <= 0) {
        return { kind: "error", message: `wait needs a whole number of seconds, not "${rawWait}"` };
    }
    const blockedAs = env["INPUT_BLOCKED-AS"] ?? "";
    if (blockedAs !== "" && blockedAs !== "success" && blockedAs !== "failure") {
        return { kind: "error", message: `blocked-as is "success" or "failure", not "${blockedAs}"` };
    }
    return {
        kind: "inputs",
        inputs: { url, door, request: env["INPUT_REQUEST"] ?? "", waitS, blockedAsFailure: blockedAs === "failure" },
    };
};

/* The gate's default request — what this workflow knows without being told: the commit, the branch, and the
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

// The step summary — the verdict where a person will actually read it, above the fold of the run page.
export const summaryOf = (verdict: GateVerdict): string =>
    `### Intentic gate: ${verdict.outcome}\n\n${verdict.reason}\n\nRun \`${verdict.runId}\` holds the full transcript in the sandbox.\n`;

// A workflow-command's payload survives only with the runner's own escaping (%, CR, LF — in that order).
const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/* The annotation the verdict earns: fail is an error whatever the settings, blocked is an error only when the
 * step is set to fail on it and a warning otherwise — visible either way, because "the check could not judge"
 * is exactly the line someone scans a green run for after an incident. Pass earns none; the summary carries it. */
export const annotationOf = (verdict: GateVerdict, blockedAsFailure: boolean): string | undefined => {
    if (verdict.outcome === "pass") {
        return undefined;
    }
    const severity = verdict.outcome === "fail" || blockedAsFailure ? "error" : "warning";
    return `::${severity}::${escapeData(`${verdict.outcome}: ${verdict.reason}`)}`;
};

// The step's exit is the CLI's: pass 0, fail 1, blocked per the setting — one mapping, imported not repeated.
export const stepExitOf = (verdict: GateVerdict, blockedAsFailure: boolean): number => exitOf(verdict, blockedAsFailure ? 1 : 0);
