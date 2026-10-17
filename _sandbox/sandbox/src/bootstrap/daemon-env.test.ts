import { os } from "@orpc/server";
import { failureOf, orpcLink } from "../peers/orpc-link.testing.js";
import { isAbandonedPeerSend, logEscaped } from "./daemon-env.js";

const recording = () => {
    const lines: { level: string; data: Record<string, unknown>; message: string }[] = [];
    const at = (level: string) => (data: Record<string, unknown>, message: string) => void lines.push({ level, data, message });
    return { lines, logger: { debug: at("debug"), error: at("error") } as never };
};

// The error oRPC's websocket peer throws from an aborted call's listener once the peer's socket has closed.
const abandonedSend = (): Error => {
    const error = new Error("Cannot send message, WebSocket is not open.");
    error.stack = `${error.message}\n    at file:///opt/sandbox/node_modules/.pnpm/@orpc+client@1.15.4/node_modules/@orpc/client/dist/adapters/websocket/index.mjs:27:15`;
    return error;
};

test("a cancel oRPC could not send to a closed peer is a trace, not an uncaught exception", () => {
    const { lines, logger } = recording();
    logEscaped(logger, abandonedSend(), "uncaught exception");
    expect(lines).toEqual([
        {
            level: "debug",
            data: { reason: "Cannot send message, WebSocket is not open." },
            message: "orpc: a call's cancel could not reach a peer whose socket had already closed",
        },
    ]);
});

test("anything else that escapes stays an error with its stack, even with the same words from elsewhere", () => {
    const { lines, logger } = recording();
    const real = new TypeError("Cannot read properties of undefined (reading 'id')");
    const lookalike = new Error("Cannot send message, WebSocket is not open.");
    logEscaped(logger, real, "uncaught exception");
    logEscaped(logger, lookalike, "unhandled rejection");
    expect(lines.map((line) => [line.level, line.message, line.data["err"]])).toEqual([
        ["error", "uncaught exception", real],
        ["error", "unhandled rejection", lookalike],
    ]);
});

// isAbandonedPeerSend can only read oRPC's words and frames (its link throws a bare Error), so this holds them to the
// installed oRPC: a send on a peer socket that has closed, which is what an abandoned call's cancel meets. The fixture
// above stands in for the stack; this is the real throw it was copied from.
test("oRPC's refused send on a closed peer socket is the one recognised", async () => {
    const { client, peer, close } = await orpcLink<{ ping: () => Promise<string> }>({ ping: os.handler(() => "pong") });
    try {
        expect(await client.ping()).toBe("pong");
        peer.terminate();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(isAbandonedPeerSend(await failureOf(client.ping()))).toBe(true);
    } finally {
        close();
    }
});
