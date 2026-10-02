import { Readable, Writable } from "node:stream";
import { webStream } from "@intentic/base/web-stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { fakeAcpAgentApp } from "./fake-acp-agent.js";

// The same fake agent over stdio, for tests of the production connection's routing.
fakeAcpAgentApp().connect(ndJsonStream(Writable.toWeb(process.stdout), webStream<Uint8Array>(Readable.toWeb(process.stdin))));
