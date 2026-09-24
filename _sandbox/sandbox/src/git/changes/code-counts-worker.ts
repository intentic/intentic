import { parentPort } from "node:worker_threads";
import { codeLineStat, rememberAnalyses, type LineStat } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import { serveCalls } from "../../workers/worker-calls.js";
import type { CodeCountAsk } from "./code-counts.js";

// Tokenizing both sides of a file with its TextMate grammar is the costly part of a code count (over a second for a
// large file); it runs on this thread, so a scan while files land holds this thread and never the daemon's loop.

const port = parentPort;
if (port === null) {
    throw new Error("the code count worker requires a parent port");
}

// Characters of source whose reading this thread keeps: a few hundred typical files, or eight at the size cap.
const KEPT_CHARACTERS = 4_000_000;
const remembered = rememberAnalyses(analyze, KEPT_CHARACTERS);

// `codeLineStat` answers undefined when no grammar ships for the path, and a throw is treated the same way.
serveCalls<CodeCountAsk & { readonly id: number }>(port, async (ask): Promise<LineStat | undefined> =>
    codeLineStat(ask.before, ask.after, ask.path, remembered).catch(() => undefined),
);
