import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createDaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// A report the daemon did not take must reach the gateway's log: nothing else ever sees it.
const recordingLog = (): { log: Logger; warned: Array<{ fields: object; msg: string }> } => {
    const warned: Array<{ fields: object; msg: string }> = [];
    const keep = (fields: object, msg: string): void => {
        warned.push({ fields, msg });
    };
    return { log: { info: () => undefined, warn: keep, error: keep }, warned };
};

afterEach(() => {
    unstubAllGlobals();
});

test("a failure the daemon refuses is logged with the sentence it carried, and the report still resolves", async () => {
    stubGlobal(
        "fetch",
        jest.fn(async () => new Response("no such provider", { status: 404 })),
    );
    const { log, warned } = recordingLog();
    await createDaemonClient("slack", "http://127.0.0.1:1", "token", log).failure("the bot token was revoked");
    expect(warned).toEqual([{ fields: { detail: "the bot token was revoked", status: 404 }, msg: "/listeners/slack/failure returned 404" }]);
});

test("a status report that cannot reach the daemon is logged with the error, and the report still resolves", async () => {
    const refused = new TypeError("fetch failed");
    stubGlobal(
        "fetch",
        jest.fn(async () => {
            throw refused;
        }),
    );
    const { log, warned } = recordingLog();
    await createDaemonClient("discord", "http://127.0.0.1:1", "token", log).status({ connections: [] });
    expect(warned).toEqual([{ fields: { err: refused }, msg: "/listeners/discord/status failed" }]);
});

test("an accepted report logs nothing", async () => {
    stubGlobal(
        "fetch",
        jest.fn(async () => new Response("ok", { status: 200 })),
    );
    const { log, warned } = recordingLog();
    await createDaemonClient("telegram", "http://127.0.0.1:1", "token", log).status({ connections: [] });
    expect(warned).toEqual([]);
});
