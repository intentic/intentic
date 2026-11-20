// Which way the media socket rides: a WebSocket on a stream of the edge's WebTransport session where one was declared
// and is ready within the grace, else the browser's own WebSocket, always the browser's own where nothing was declared.
import type { StreamRequest } from "../../../../client/transport/streamSocket";
import type { SocketLike } from "./decodeSeams";
import { GRACE_MS, mediaCarrier } from "./mediaCarrier";

const URL_ON_EDGE = `wss://sandbox-abcdef012345.sbx.test/system/browser-media/cast-1?token=a.b`;

const fakeSocket = (kind: string): SocketLike & { readonly kind: string } => ({
    kind,
    binaryType: `blob`,
    readyState: 0,
    send: () => undefined,
    close: () => undefined,
    addEventListener: () => undefined,
});

const harness = (session: () => Promise<{ createBidirectionalStream(): Promise<WebTransportBidirectionalStream> } | undefined>) => {
    const asked: { base: string; graceMs: number }[] = [];
    const streams: StreamRequest[] = [];
    const dial = mediaCarrier({
        session: (base, graceMs) => {
            asked.push({ base, graceMs });
            return session();
        },
        webSocket: (url) => fakeSocket(`websocket ${url}`),
        streamSocket: (_opening, request) => {
            streams.push(request);
            return fakeSocket(`stream`);
        },
    });
    return { dial, asked, streams };
};

const opening = new Promise<WebTransportBidirectionalStream>(() => undefined);

it("rides a stream of the edge's session, asking for exactly the upgrade a WebSocket would", async () => {
    const { dial, asked, streams } = harness(async () => ({ createBidirectionalStream: () => opening }));
    const socket = await dial(URL_ON_EDGE, true);
    expect(socket).toMatchObject({ kind: `stream` });
    expect(asked).toEqual([{ base: `https://sandbox-abcdef012345.sbx.test`, graceMs: GRACE_MS }]);
    expect(streams).toEqual([{ host: `sandbox-abcdef012345.sbx.test`, path: `/system/browser-media/cast-1`, query: `token=a.b` }]);
});

it("takes the browser's own WebSocket when no session is ready in time, or asking for one failed", async () => {
    expect(await harness(async () => undefined).dial(URL_ON_EDGE, true)).toMatchObject({ kind: `websocket ${URL_ON_EDGE}` });
    expect(await harness(() => Promise.reject(new Error(`no session`))).dial(URL_ON_EDGE, true)).toMatchObject({ kind: `websocket ${URL_ON_EDGE}` });
});

it("never asks for a session where none was declared, or on a plain ws address", () => {
    const { dial, asked } = harness(async () => undefined);
    expect(dial(URL_ON_EDGE, false)).toMatchObject({ kind: `websocket ${URL_ON_EDGE}` });
    expect(dial(`ws://127.0.0.1:28123/system/browser-media/cast-1?token=t`, true)).toMatchObject({ kind: `websocket ws://127.0.0.1:28123/system/browser-media/cast-1?token=t` });
    expect(asked).toEqual([]);
});
