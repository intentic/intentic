import { deskEdition, freshEdition } from "../../mode";
import { workspaceEntries } from "../../fixture/workspace";
import { bytesOf, holdBytes } from "./bytes";
import { webmOf, type WebmFrame } from "./webm";

// The checkout walkthrough the shop's agent recorded: a real VP8 video in a WebM, drawn and encoded in the page the
// first time something plays it (the browser's own WebCodecs, as videoCast.ts encodes the live desktop), so the demo
// carries a recording that plays and seeks without shipping one. Until then the tree lists it at about its size.

const WALKTHROUGH_PATH = `web/public/media/checkout-walkthrough.webm`;

const SIZE = { width: 640, height: 360 } as const;
const FPS = 12;
const SECONDS = 8;
// A key frame each second, so a seek lands within a second of where it was asked.
const KEY_EVERY = FPS;

const STEPS = [
    { title: `Basket`, note: `Blue jug × 1 · Linen apron × 2`, total: `€86.00` },
    { title: `Shipping`, note: `Germany · DHL Paket, 2–3 days`, total: `€90.90` },
    { title: `Payment`, note: `Card ending 4242 · Stripe test mode`, total: `€90.90` },
    { title: `Order placed`, note: `Confirmation sent to ada@acme.dev`, total: `#A-1042` },
] as const;

const paint = (context: OffscreenCanvasRenderingContext2D, seconds: number): void => {
    const step = STEPS[Math.min(STEPS.length - 1, Math.floor((seconds / SECONDS) * STEPS.length))] ?? STEPS[0];
    context.fillStyle = `#fafaf9`;
    context.fillRect(0, 0, SIZE.width, SIZE.height);
    context.fillStyle = `#e7e5e4`;
    context.fillRect(0, 0, SIZE.width, 36);
    context.fillStyle = `#78716c`;
    context.font = `14px system-ui, sans-serif`;
    context.fillText(`shop.acme.dev/checkout`, 16, 23);
    context.fillStyle = `#c2410c`;
    context.font = `bold 30px system-ui, sans-serif`;
    context.fillText(step.title, 40, 110);
    context.fillStyle = `#1c1917`;
    context.font = `18px system-ui, sans-serif`;
    context.fillText(step.note, 40, 150);
    context.font = `bold 22px system-ui, sans-serif`;
    context.fillText(step.total, 40, 200);
    // The progress bar and the clock, so a seek shows where it landed.
    context.fillStyle = `#e7e5e4`;
    context.fillRect(40, 300, SIZE.width - 80, 8);
    context.fillStyle = `#c2410c`;
    context.fillRect(40, 300, ((SIZE.width - 80) * seconds) / SECONDS, 8);
    context.fillStyle = `#78716c`;
    context.font = `14px ui-monospace, monospace`;
    context.fillText(`0:0${Math.floor(seconds)}.${String(Math.floor((seconds % 1) * 10))}`, SIZE.width - 100, 330);
};

const canEncode = (): boolean => `VideoEncoder` in globalThis && `OffscreenCanvas` in globalThis;

const encode = async (): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    if (!canEncode()) {
        return undefined;
    }
    const frames: WebmFrame[] = [];
    const encoder = new VideoEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            frames.push({ data, at: chunk.timestamp / 1000, key: chunk.type === `key` });
        },
        error: (error) => console.warn(`[demo] the walkthrough could not be encoded:`, error),
    });
    encoder.configure({ codec: `vp8`, ...SIZE, bitrate: 600_000, framerate: FPS });
    const canvas = new OffscreenCanvas(SIZE.width, SIZE.height);
    const context = canvas.getContext(`2d`);
    if (context === null) {
        return undefined;
    }
    for (let index = 0; index < FPS * SECONDS; index += 1) {
        paint(context, index / FPS);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1_000_000) / FPS) });
        encoder.encode(frame, { keyFrame: index % KEY_EVERY === 0 });
        frame.close();
    }
    await encoder.flush();
    encoder.close();
    return frames.length === 0 ? undefined : webmOf(frames, SIZE, SECONDS * 1000);
};

// What the tree lists it at until it is recorded: about what eight seconds at this rate come to.
const LISTED_SIZE = 184_320;
let recorded: Promise<void> | undefined;

// Listed from the start at about the size it will have; the shop's tree only.
if (!deskEdition && !freshEdition && !workspaceEntries().has(WALKTHROUGH_PATH)) {
    workspaceEntries().set(WALKTHROUGH_PATH, LISTED_SIZE);
}

/** A file's bytes for a player or a download: the walkthrough recorded first if this is it and it never was. */
export const mediaBytes = async (path: string): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    if (path === WALKTHROUGH_PATH && workspaceEntries().get(path) === LISTED_SIZE) {
        recorded ??= encode().then((bytes) => {
            if (bytes !== undefined) {
                holdBytes(WALKTHROUGH_PATH, bytes);
            }
        });
        await recorded;
    }
    return bytesOf(path);
};
