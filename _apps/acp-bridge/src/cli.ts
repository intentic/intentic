#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { bridgeAgentApp } from "./bridge.js";
import { runLogin } from "./login.js";

/* Two commands, no CLI framework: the DEFAULT invocation serves ACP on stdio (what the editor spawns —
 * stdout is the protocol, so nothing else may print there), and `login` runs the interactive terminal auth
 * flow. The registry's npx distribution and the ACP terminal auth method both invoke this same binary. */

const command = process.argv[2];

if (command === "login") {
    process.exitCode = await runLogin();
} else {
    const stream = ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );
    bridgeAgentApp().connect(stream);
    // The connection lives until the editor closes stdin; keep the process alive alongside it.
    await new Promise<void>((resolve) => process.stdin.once("close", resolve));
}
