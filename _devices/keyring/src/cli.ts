#!/usr/bin/env node
import { run } from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { app } from "./app.js";
import { askpass, startedAsAskpass } from "./askpass/askpass-run.js";

// One binary, two names: as intentic-askpass (a hard link to it) every argument is the prompt to answer.
if (startedAsAskpass()) {
    process.exitCode = await askpass(process.argv.slice(2).join(" "), process.stdout, process.stderr);
} else {
    // SAFETY: Node's process is the StricliProcess stricli runs on; its type names only the two streams and exit code.
    await run(app, process.argv.slice(2), { process: process as StricliProcess });
}
