/* The process around action.ts: environment in, appended runner files and an exit code out, the same
 * relationship gate's cli.ts has to gate.ts. Bundled whole to dist/index.mjs and synced to the public action
 * repository, where the runner executes it directly; nothing here may assume node_modules exists.
 *
 * EXIT 2 IS NEVER A VERDICT, here as in the CLI: 0/1 (and blocked's mapping) come from the verdict's own
 * outcome, and 2 means the exchange itself broke, wrong token, no such door, the daily ceiling, a network
 * that ate the reply. Both fail the step the same way on GitHub; the code and the message keep the two
 * apart for whoever reads the log, because they need opposite responses from whoever is on call. */

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { clientTimeoutMs, readVerdict, targetOf } from "@intentic/gate";
import { annotationOf, defaultRequest, outputLines, parseInputs, stepExitOf, summaryOf } from "./action.js";

// A runner file is append-only shared state; absent (running outside a runner) the write is simply skipped,
// the log lines below carry the same facts.
const appendTo = (file: string | undefined, content: string): void => {
    if (file !== undefined && file !== "") {
        appendFileSync(file, content);
    }
};

// A function declaration, not the file's usual const arrow: control-flow analysis only treats a call as
// terminal when the callee is a declaration (or an explicitly typed const), and everything below relies on
// "wiring() was called" meaning "this path ended".
function wiring(message: string): never {
    console.error(`::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    process.exit(2);
}

// The daemon's own sentence when it has one ({"error": ...}), the raw body when it does not (a proxy or
// tunnel answered, the raw body is the only clue there is).
const detailOf = (text: string): string => {
    try {
        const body = JSON.parse(text) as { error?: unknown };
        return typeof body.error === "string" ? body.error : text;
    } catch {
        return text;
    }
};

const parsed = parseInputs(process.env);
if (parsed.kind === "error") {
    wiring(parsed.message);
}
const { inputs } = parsed;

// The event payload the runner already wrote to disk, the same JSON a GitHub webhook would have delivered,
// which is exactly what an event automation's prompt was written against. Unreadable means no payload.
const eventText = ((): string => {
    const path = process.env["GITHUB_EVENT_PATH"];
    if (path === undefined || path === "") {
        return "";
    }
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
})();

if (inputs.door === "fire") {
    const body = inputs.request !== "" ? inputs.request : eventText;
    let response: Response;
    try {
        // The fire route answers immediately, the minute is for the network, not for the agent.
        response = await fetch(inputs.url, { method: "POST", body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
        wiring(`the automation could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        wiring(`the automation answered ${response.status}: ${detailOf(await response.text())}`);
    }
    console.log("woke the agent — the automation accepted the payload and the run continues without this workflow");
    process.exit(0);
}

const event = ((): unknown => {
    try {
        return eventText === "" ? undefined : JSON.parse(eventText);
    } catch {
        return undefined;
    }
})();
const request = inputs.request !== "" ? inputs.request : defaultRequest(process.env, event);
if (request === "") {
    wiring("nothing to tell the agent: set `with: request` (no workflow context to compose one from)");
}

let response: Response;
try {
    response = await fetch(targetOf(inputs.url, inputs.waitS), {
        method: "POST",
        body: request,
        signal: AbortSignal.timeout(clientTimeoutMs(inputs.waitS)),
    });
} catch (error) {
    wiring(`the gate could not be reached: ${error instanceof Error ? error.message : String(error)}`);
}
const text = await response.text();
if (!response.ok) {
    wiring(`the gate answered ${response.status}: ${detailOf(text)}`);
}
let body: unknown;
try {
    body = JSON.parse(text);
} catch {
    body = undefined;
}
const verdict = readVerdict(body);
if (verdict === undefined) {
    wiring(`the gate's answer was not a verdict: ${text.slice(0, 200)}`);
}

appendTo(process.env["GITHUB_OUTPUT"], outputLines(verdict, randomUUID()));
appendTo(process.env["GITHUB_STEP_SUMMARY"], summaryOf(verdict));
// The same two lines the CLI prints, the reason IS the product of this whole exchange, and the run id is
// what a person pastes into the sandbox when the one line is not enough.
console.log(`${verdict.outcome}: ${verdict.reason}`);
console.log(`run ${verdict.runId}`);
const annotation = annotationOf(verdict, inputs.blockedAsFailure);
if (annotation !== undefined) {
    console.log(annotation);
}
process.exit(stepExitOf(verdict, inputs.blockedAsFailure));
