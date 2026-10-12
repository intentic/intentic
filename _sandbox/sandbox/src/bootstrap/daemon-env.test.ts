import { logEscaped } from "./daemon-env.js";

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
