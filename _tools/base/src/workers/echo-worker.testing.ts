import { readFile } from "node:fs/promises";
import { parentPort, threadId } from "node:worker_threads";
import { post, serveCalls } from "./worker-calls.js";

// A worker for worker-calls.test.ts: echoes, refuses, dies, names its thread, or reports news on command.

const port = parentPort;
if (port === null) {
    throw new Error("the echo worker requires a parent port");
}

type Ask = { readonly id: number; readonly say: string };

serveCalls<Ask>(port, async (ask) => {
    if (ask.say === "refuse") {
        throw new Error("refused");
    }
    // A real errno failure, wrapped: what the caller must still be able to read by its code.
    if (ask.say === "missing") {
        try {
            await readFile("/intentic-no-such-file");
        } catch (cause) {
            throw new TypeError("could not read it", { cause });
        }
    }
    if (ask.say === "die") {
        process.exit(3);
    }
    // Held a moment, so calls issued together are in flight together, then names the thread that answered.
    if (ask.say === "thread") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return threadId;
    }
    if (ask.say === "news") {
        post(port, { news: "fresh" });
    }
    return `echo:${ask.say}`;
});
