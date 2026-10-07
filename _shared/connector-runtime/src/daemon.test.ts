import { createDaemonApi } from "@intentic/extension-api/runtime";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createDaemonClient, type DaemonDoor } from "./daemon.js";
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

// The process api's door as the runtime builds it, reduced to where it sends: the stubbed fetch, read per call.
const door: DaemonDoor = { request: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:1${path}`, init) };

test("a failure the daemon refuses is logged with the sentence it carried, and the report still resolves", async () => {
    stubGlobal(
        "fetch",
        jest.fn(async () => new Response("no such provider", { status: 404 })),
    );
    const { log, warned } = recordingLog();
    await createDaemonClient("slack", door, log).failure("the bot token was revoked");
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
    await createDaemonClient("discord", door, log).status({ connections: [] });
    expect(warned).toEqual([{ fields: { err: refused }, msg: "/listeners/discord/status failed" }]);
});

test("an accepted report logs nothing", async () => {
    stubGlobal(
        "fetch",
        jest.fn(async () => new Response("ok", { status: 200 })),
    );
    const { log, warned } = recordingLog();
    await createDaemonClient("telegram", door, log).status({ connections: [] });
    expect(warned).toEqual([]);
});

// The listener routes answer only the extension's own token, so every call carries it in the extension grant's header
// and nothing in the panel token's.
test("every call rides the extension token header", async () => {
    const seen: Headers[] = [];
    stubGlobal(
        "fetch",
        jest.fn(async (_url: string, init?: RequestInit) => {
            seen.push(new Headers(init?.headers));
            return new Response(JSON.stringify({ automations: [], connectors: [] }), { status: 200 });
        }),
    );
    const { log } = recordingLog();
    // The door a gateway is actually handed: the process api's, which presents the extension's token on every request.
    const api = createDaemonApi({ url: "http://127.0.0.1:1", token: "ext-token", id: "intentic.discord", permissions: [] });
    const client = createDaemonClient("discord", api, log);
    await client.state();
    await client.status({ connections: [] });
    expect(seen.map((headers) => headers.get("x-intentic-extension"))).toEqual(["ext-token", "ext-token"]);
    expect(seen.filter((headers) => headers.has("x-intentic-panel"))).toEqual([]);
});
