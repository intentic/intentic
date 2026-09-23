import { parentPort } from "node:worker_threads";
import { codeLineStat, type LineStat } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import { serveCalls } from "../../worker-calls.js";
import type { CodeCountAsk } from "./code-counts.js";

// Tokenizing both sides of a file with its TextMate grammar is the costly part of a code count (over a second for a
// large file); it runs on this thread, so a scan while files land holds this thread and never the daemon's loop.

const port = parentPort;
if (port === null) {
    throw new Error("the code count worker requires a parent port");
}

// `codeLineStat` answers undefined when no grammar ships for the path, and a throw is treated the same way.
serveCalls<CodeCountAsk & { readonly id: number }>(port, async (ask): Promise<LineStat | undefined> =>
    codeLineStat(ask.before, ask.after, ask.path, analyze).catch(() => undefined),
);
