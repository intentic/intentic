#!/usr/bin/env node
import { clientTimeoutMs, exitOf, parseArgs, readVerdict, targetOf, USAGE } from "./gate.js";

/* The process around gate.ts: stdin, one fetch, stdout, an exit code. No CLI framework, two options and a
 * body do not earn one (the acp-bridge CLI set the precedent).
 *
 * EXIT 2 IS NEVER A VERDICT. The daemon answers every verdict, including fail, as HTTP 200, so the status
 * line cleanly separates "the exchange worked" from "what the product is" (gate.routes.ts). This process keeps
 * that separation: 0/1 and the blocked exit come from the verdict's own outcome, and 2 means the exchange
 * itself broke, wrong token, no such gate, the daily ceiling, a network that ate the reply. Folding those
 * into `fail` would page whoever owns the PRODUCT for a problem in the pipeline's WIRING. */

const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

const parsed = parseArgs(process.argv.slice(2), process.env["INTENTIC_GATE_URL"]);
if (parsed.kind === "help") {
    console.log(USAGE);
    process.exit(0);
}
if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error(`\n${USAGE}`);
    process.exit(2);
}

const { call } = parsed;
// No words on the command line ⇒ the request rides in on stdin, but only when something is actually piped:
// waiting on an interactive terminal's stdin would hang a pipeline that forgot the body, forever.
const request = call.request !== "" ? call.request : process.stdin.isTTY ? "" : (await readStdin()).trim();

let response: Response;
try {
    response = await fetch(targetOf(call.url, call.waitS), {
        method: "POST",
        body: request,
        signal: AbortSignal.timeout(clientTimeoutMs(call.waitS)),
    });
} catch (error) {
    console.error(`the gate could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
}

const text = await response.text();
if (!response.ok) {
    // The daemon's own sentence when it has one ({"error": ...}), the raw body when it does not.
    let detail = text;
    try {
        const body = JSON.parse(text) as { error?: unknown };
        detail = typeof body.error === "string" ? body.error : text;
    } catch {
        // Not JSON, a proxy or tunnel answered. The raw body is the only clue there is.
    }
    console.error(`the gate answered ${response.status}: ${detail}`);
    process.exit(2);
}

let body: unknown;
try {
    body = JSON.parse(text);
} catch {
    body = undefined;
}
const verdict = readVerdict(body);
if (verdict === undefined) {
    console.error(`the gate's answer was not a verdict: ${text.slice(0, 200)}`);
    process.exit(2);
}

// One line for the pipeline log, the reason IS the product of this whole exchange, and the run id under it,
// which is what a person pastes into the workflow run view when the one line is not enough.
console.log(`${verdict.outcome}: ${verdict.reason}`);
console.log(`run ${verdict.runId}`);
process.exit(exitOf(verdict, call.blockedExit));
