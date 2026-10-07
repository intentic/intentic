#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { exitOf, GateExchangeError, gateExchange, type GateVerdict, parseArgs, USAGE } from "./gate.js";
import { exitOfRun, parseRunArgs, RUN_USAGE, RunExchangeError, type RunOutcome, runExchange } from "./run.js";

// Reads stdin, makes one fetch, writes stdout, and exits. Exit 2 means the exchange itself failed (bad token, no such
// gate, daily ceiling, network); 0, 1, and the blocked exit come only from the verdict's own outcome.

const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

// `run` dispatches to the API exchange in run.ts, matched on the first argument.
if (process.argv[2] === "run") {
    const parsedRun = parseRunArgs(process.argv.slice(3), process.env, randomUUID);
    if (parsedRun.kind === "help") {
        console.log(RUN_USAGE);
        process.exit(0);
    }
    if (parsedRun.kind === "error") {
        console.error(parsedRun.message);
        console.error(`\n${RUN_USAGE}`);
        process.exit(2);
    }
    const { call } = parsedRun;
    const prompt = call.prompt !== "" ? call.prompt : process.stdin.isTTY ? "" : (await readStdin()).trim();
    if (prompt === "") {
        console.error("nothing to tell the agent: pass the prompt as arguments or on stdin");
        process.exit(2);
    }
    let outcome: RunOutcome;
    try {
        outcome = await runExchange({ ...call, prompt }, { fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now });
    } catch (error) {
        console.error(error instanceof RunExchangeError ? error.message : errorMessage(error));
        process.exit(2);
    }
    console.log(`${outcome.status}: ${outcome.summary}`);
    console.log(`conversation ${outcome.conversationId}${outcome.branch === undefined ? "" : ` on ${outcome.branch}`}${outcome.landed === undefined ? "" : outcome.landed ? ", landed" : ", not landed"}`);
    process.exit(exitOfRun(outcome.status));
}

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
// No words on the command line falls back to stdin, but only when piped in, not an interactive terminal.
const request = call.request !== "" ? call.request : process.stdin.isTTY ? "" : (await readStdin()).trim();

let verdict: GateVerdict;
try {
    verdict = await gateExchange({ ...call, request }, { fetch });
} catch (error) {
    console.error(error instanceof GateExchangeError ? error.message : errorMessage(error));
    process.exit(2);
}

// Outcome and reason for the pipeline log; run id below it, for pasting into the workflow run view.
console.log(`${verdict.outcome}: ${verdict.reason}`);
console.log(`run ${verdict.runId}`);
process.exit(exitOf(verdict, call.blockedExit));
