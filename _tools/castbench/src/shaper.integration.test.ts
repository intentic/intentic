import { createServer, type Server, type Socket, connect } from "node:net";
import { performance } from "node:perf_hooks";
import { DIRECT, parseLink } from "./link.js";
import { type Relay, startRelay } from "./shaper.js";

// The relay over real loopback sockets: bytes arrive whole and in order, and a shaped link never delivers sooner than
// its delay and rate allow. Only lower bounds are asserted: a busy machine makes a relay slower, never faster, so a
// floor holds under any load where a ceiling would not.

let upstream: Server | undefined;
let relay: Relay | undefined;

afterEach(async () => {
    await relay?.close();
    await new Promise<void>((resolve) => (upstream === undefined ? resolve() : upstream.close(() => resolve())));
    upstream = undefined;
    relay = undefined;
});

// An upstream that sends `payload` the moment a client connects, and echoes whatever it is sent.
const serve = async (payload: Buffer): Promise<number> => {
    upstream = createServer((socket: Socket) => {
        socket.write(payload);
        socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: listening on a TCP port.
    return (upstream.address() as { port: number }).port;
};

// Connects through the relay and resolves once `bytes` have arrived, with them and how long that took.
const receive = (port: number, bytes: number, send?: Buffer): Promise<{ readonly data: Buffer; readonly ms: number }> =>
    new Promise((resolve, reject) => {
        const started = performance.now();
        const chunks: Buffer[] = [];
        let total = 0;
        const socket = connect({ host: "127.0.0.1", port }, () => {
            if (send !== undefined) {
                socket.write(send);
            }
        });
        socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            total += chunk.byteLength;
            if (total >= bytes) {
                socket.destroy();
                resolve({ data: Buffer.concat(chunks), ms: performance.now() - started });
            }
        });
        socket.on("error", reject);
    });

const pattern = (length: number): Buffer => Buffer.from(Array.from({ length }, (_, index) => index % 251));

describe("the relay", () => {
    it("carries bytes whole and in order on the direct link, and counts them", async () => {
        const payload = pattern(300_000);
        relay = await startRelay({ port: await serve(payload) }, DIRECT);
        const { data } = await receive(relay.port, payload.byteLength);
        expect(data.equals(payload)).toBe(true);
        expect(relay.downBytes()).toBe(payload.byteLength);
    });

    it("delays the downstream by half the round trip at least", async () => {
        relay = await startRelay({ port: await serve(pattern(100)) }, parseLink("1000mbit-80ms"));
        const { ms } = await receive(relay.port, 100);
        expect(ms).toBeGreaterThanOrEqual(40);
    });

    it("never delivers faster than the link's rate, and still delivers every byte in order", async () => {
        // 125,000 bytes at 10 Mbit/s is 100 ms on the wire.
        const payload = pattern(125_000);
        relay = await startRelay({ port: await serve(payload) }, parseLink("10mbit-0ms"));
        const { data, ms } = await receive(relay.port, payload.byteLength);
        expect(ms).toBeGreaterThanOrEqual(95);
        expect(data.equals(payload)).toBe(true);
    });

    it("delays the upstream by half the round trip too, so an echo costs the whole of it", async () => {
        relay = await startRelay({ port: await serve(Buffer.alloc(0)) }, parseLink("1000mbit-60ms"));
        const { data, ms } = await receive(relay.port, 4, Buffer.from("ping"));
        expect(String(data)).toBe("ping");
        expect(ms).toBeGreaterThanOrEqual(60);
    });
});
