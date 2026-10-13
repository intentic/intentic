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

// One bad line in a streamed reply used to throw out of JSON.parse and end the dispatch, losing every frame after it.
test("a streamed dispatch skips and logs a line that is not JSON, and delivers the frames around it", async () => {
    const bytes = new TextEncoder().encode(`{"automationId":"a1","delta":"héllo"}\nnot json\n\n{"automationId":"a1","end":true}`);
    // The "é" is split across two chunks, as a network may deliver it.
    const cut = bytes.indexOf(0xc3) + 1;
    stubGlobal(
        "fetch",
        jest.fn(async () => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes.subarray(0, cut));
                    controller.enqueue(bytes.subarray(cut));
                    controller.close();
                },
            });
            return new Response(body, { status: 200 });
        }),
    );
    const { log, warned } = recordingLog();
    const received: unknown[] = [];
    const message = { provider: "slack", type: "message", id: "m1", channelId: "c1", author: { id: "u1", name: "U" }, content: "hi", timestamp: "0" };
    await createDaemonClient("slack", door, log).dispatchStreaming(message, (frame) => received.push(frame));
    expect(received).toEqual([
        { automationId: "a1", delta: "héllo" },
        { automationId: "a1", end: true },
    ]);
    expect(warned.map((entry) => entry.fields)).toEqual([{ line: "not json" }]);
});

// Discord's calls speak through this: the text goes as the body, the language as a hint, and the PCM comes back as it is
// made at the rate the daemon names once for the whole answer.
test("speak posts the text and streams back the daemon's PCM at the rate it names", async () => {
    const seen: Array<{ url: string; body: string; type: string | null }> = [];
    stubGlobal(
        "fetch",
        jest.fn(async (url: string, init?: RequestInit) => {
            seen.push({ url, body: String(init?.body), type: new Headers(init?.headers).get("content-type") });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 0, 2]));
                    controller.enqueue(new Uint8Array([0]));
                    controller.close();
                },
            });
            return new Response(body, { status: 200, headers: { "x-sample-rate": "24000", "content-type": "audio/L16; rate=24000; channels=1" } });
        }),
    );
    const { log } = recordingLog();
    const speech = await createDaemonClient("discord", door, log).speak("Dzień dobry.", { lang: "pl" });
    expect(speech?.sampleRate).toBe(24_000);
    const chunks: number[][] = [];
    for await (const chunk of speech?.pcm ?? []) {
        chunks.push([...chunk]);
    }
    expect(chunks).toEqual([[1, 0, 2], [0]]);
    expect(seen).toEqual([{ url: "http://127.0.0.1:1/speech/say?as=plain&lang=pl", body: "Dzień dobry.", type: "text/plain; charset=utf-8" }]);
});

test("speak reads 204 as nothing to say, and a refusal as an error carrying the daemon's words", async () => {
    const answers = [new Response(null, { status: 204 }), new Response(JSON.stringify({ error: "no speech runtime for linux-riscv64" }), { status: 501 })];
    stubGlobal(
        "fetch",
        jest.fn(async () => answers.shift() ?? new Response("unexpected", { status: 500 })),
    );
    const { log } = recordingLog();
    const client = createDaemonClient("discord", door, log);
    expect(await client.speak("```ts```")).toBeUndefined();
    await expect(client.speak("hello")).rejects.toThrow('/speech/say returned 501: {"error":"no speech runtime for linux-riscv64"}');
});

// Stop is a person's press relayed: the daemon's answer comes back as it said it, and a refusal of the route itself is an
// error carrying what the daemon said, never a silent "not stopped".
test("stop posts who pressed it and for which conversation, and hands back the daemon's answer", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    stubGlobal(
        "fetch",
        jest.fn(async (url: string, init?: RequestInit) => {
            sent.push({ url, body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ stopped: false, reason: "Only someone the assistant answers can stop it." }), { status: 200 });
        }),
    );
    const { log } = recordingLog();
    const stop = { conversationId: "conv-1", author: { id: "u1", name: "mark", groups: ["g1"] } };
    expect(await createDaemonClient("discord", door, log).stop(stop)).toEqual({ stopped: false, reason: "Only someone the assistant answers can stop it." });
    expect(sent).toEqual([{ url: "http://127.0.0.1:1/listeners/discord/stop", body: stop }]);
});

test("a stop the route refuses is an error naming the status and the daemon's words", async () => {
    stubGlobal(
        "fetch",
        jest.fn(async () => new Response("invalid stop body", { status: 400 })),
    );
    const { log } = recordingLog();
    await expect(createDaemonClient("discord", door, log).stop({ conversationId: "c", author: { id: "u", name: "u" } })).rejects.toThrow(
        "/listeners/discord/stop returned 400: invalid stop body",
    );
});
