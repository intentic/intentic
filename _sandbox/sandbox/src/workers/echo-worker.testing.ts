import { parentPort } from "node:worker_threads";
import { post, serveCalls } from "./worker-calls.js";

// A worker for worker-calls.test.ts: echoes, refuses, dies, or reports news on command.

const port = parentPort;
if (port === null) {
    throw new Error("the echo worker requires a parent port");
}

type Ask = { readonly id: number; readonly say: string };

serveCalls<Ask>(port, async (ask) => {
    if (ask.say === "refuse") {
        throw new Error("refused");
    }
    if (ask.say === "die") {
        process.exit(3);
    }
    if (ask.say === "news") {
        post(port, { news: "fresh" });
    }
    return `echo:${ask.say}`;
});
