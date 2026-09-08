// Process around action.ts: environment in, appended runner files and an exit code out; bundled whole to dist/index.mjs
// for the public action repo, so nothing here may assume node_modules exists.
// Exit 2 is never a verdict: 0/1 (and blocked's mapping) come from the verdict's own outcome, 2 means the exchange
// itself broke (wrong token, no such door, the daily ceiling, a dead network).
// Both fail the step the same way on GitHub; the code and message tell on-call which kind of failure it was.

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { clientTimeoutMs, conversationIdFor, detailOf, dialOf, readVerdict, RunExchangeError, type RunOutcome, runExchange } from "@intentic/gate";
import {
    annotationOf,
    defaultRequest,
    outputLines,
    parseInputs,
    runAnnotationOf,
    runOutputLines,
    runStepExitOf,
    runSummaryOf,
    stepExitOf,
    summaryOf,
} from "./action.js";

// A runner file is append-only; missing outside a runner, the write is skipped and logged instead.
const appendTo = (file: string | undefined, content: string): void => {
    if (file !== undefined && file !== "") {
        appendFileSync(file, content);
    }
};

// A function declaration, not the file's usual const arrow, since control-flow analysis only treats a call as terminal
// for a declared function.
// Everything below relies on `wiring()` meaning this path ended.
function wiring(message: string): never {
    console.error(`::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    process.exit(2);
}

const parsed = parseInputs(process.env);
if (parsed.kind === "error") {
    wiring(parsed.message);
}
const { inputs } = parsed;

// Event payload the runner wrote to disk, the same JSON a webhook would deliver; unreadable means no payload.
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

// API with a control token, no door: starts the turn, waits for the card to settle, lands if asked.
// Reports how it ended in the runner's own vocabulary; run.ts in @intentic/gate is the exchange itself.
if (inputs.door === "run") {
    const call = {
        origin: new URL(inputs.url).origin,
        token: inputs.token ?? "",
        prompt: inputs.request,
        conversationId: conversationIdFor(process.env, randomUUID),
        ...(inputs.agent === undefined ? {} : { agent: inputs.agent }),
        waitS: inputs.waitS,
        land: inputs.land,
    };
    let outcome: RunOutcome;
    try {
        outcome = await runExchange(call, { fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now });
    } catch (error) {
        wiring(error instanceof RunExchangeError ? error.message : `the agent could not be run: ${errorMessage(error)}`);
    }
    appendTo(process.env["GITHUB_OUTPUT"], runOutputLines(outcome, randomUUID()));
    appendTo(process.env["GITHUB_STEP_SUMMARY"], runSummaryOf(outcome));
    console.log(`${outcome.status}: ${outcome.summary}`);
    console.log(`conversation ${outcome.conversationId}${outcome.branch === undefined ? "" : ` on ${outcome.branch}`}`);
    const runAnnotation = runAnnotationOf(outcome);
    if (runAnnotation !== undefined) {
        console.log(runAnnotation);
    }
    process.exit(runStepExitOf(outcome));
}

if (inputs.door === "fire") {
    const body = inputs.request !== "" ? inputs.request : eventText;
    let response: Response;
    try {
        // Fire answers immediately; the minute bounds the network, not the agent.
        const dial = dialOf(inputs.url);
        response = await fetch(dial.url, { method: "POST", headers: dial.headers, body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
        wiring(`the automation could not be reached: ${errorMessage(error)}`);
    }
    if (!response.ok) {
        wiring(`the automation answered ${response.status}: ${detailOf(await response.text())}`);
    }
    console.log("woke the agent: the automation accepted the payload and the run continues without this workflow");
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
    const dial = dialOf(inputs.url, inputs.waitS);
    response = await fetch(dial.url, {
        method: "POST",
        headers: dial.headers,
        body: request,
        signal: AbortSignal.timeout(clientTimeoutMs(inputs.waitS)),
    });
} catch (error) {
    wiring(`the gate could not be reached: ${errorMessage(error)}`);
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
// Same two lines the CLI prints: the reason is the exchange's product, the run id gets pasted into the sandbox.
console.log(`${verdict.outcome}: ${verdict.reason}`);
console.log(`run ${verdict.runId}`);
const annotation = annotationOf(verdict, inputs.blockedAsFailure);
if (annotation !== undefined) {
    console.log(annotation);
}
process.exit(stepExitOf(verdict, inputs.blockedAsFailure));
