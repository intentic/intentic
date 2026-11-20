import { request } from "node:http";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

/* castd's control routes, asked on its Unix socket: the daemon's side of `GET /health`, `GET /geometry`, `POST /pin`,
   `POST /unpin`, `POST /crop`, `GET /screenshot`, `GET /wait`, `POST /record/start|stop` and `POST /viewers/drop`
   (castd's src/server.rs, record.rs, wait.rs). They need no token: the socket file's 0600 is their guard, and netd never relays a path that
   reaches them (only the media path's upgrade). */

// One answer off castd's control socket: its status, its body as bytes (a PNG, an MP4) and as text, and the headers a
// caller reads (a screenshot's `x-castd-seq`).
export interface CastAnswer {
    readonly status: number;
    readonly body: string;
    readonly bytes: Buffer;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

// `timeoutMs` bounds a call that is slow on purpose (a wait, a recording's MP4); others get two seconds.
export type Ask = (socket: string, method: "GET" | "POST", path: string, timeoutMs?: number) => Promise<CastAnswer | undefined>;

// HTTP/1.1 on the Unix socket, undefined for no answer at all (nothing listening, a hang past its deadline).
export const askSocket: Ask = (socket, method, path, timeoutMs = 2_000) =>
    new Promise((resolve) => {
        const asked = request({ socketPath: socket, method, path, timeout: timeoutMs, headers: { host: "castd" } }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
                const bytes = Buffer.concat(chunks);
                resolve({ status: response.statusCode ?? 0, body: bytes.toString("utf8"), bytes, headers: response.headers });
            });
            response.on("error", () => resolve(undefined));
        });
        asked.on("timeout", () => asked.destroy());
        asked.on("error", () => resolve(undefined));
        asked.end();
    });

const SizeSchema = z.object({ width: z.number(), height: z.number() });

// What GET /geometry answers, as far as the daemon reads it; castd may say more.
export const CastGeometrySchema = z.object({
    // The picture, in display pixels: the crop's size under `--crop`, else the screen's.
    width: z.number(),
    height: z.number(),
    // Display pixels per CSS pixel, as the driving viewer last asked.
    scale: z.number(),
    screen: SizeSchema,
    crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
    resizable: z.boolean(),
    // castd fits every toplevel that covered the old screen to the new one itself, as a window manager would.
    fitsWindows: z.boolean().optional(),
    // castd publishes the scale as XSETTINGS Xft/DPI itself; absent, screen-fit.ts runs xsettingsd for it.
    xsettings: z.boolean().optional(),
    pinned: SizeSchema.extend({ scale: z.number() }).nullable().optional(),
});

export type CastGeometry = z.infer<typeof CastGeometrySchema>;

// A rectangle of the screen, in display pixels.
export interface CropRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

// What GET /wait answers: whether anything changed, whether it gave up, and the change count to wait on from next.
const CastWaitSchema = z.object({ changed: z.boolean(), timed_out: z.boolean(), seq: z.number(), waited_ms: z.number() });
export type CastWait = z.infer<typeof CastWaitSchema>;

// POST /record/start's answer: the recording's id, and how long castd lets it run before it stops by itself.
const RecordingSchema = z.object({ id: z.number(), max_seconds: z.number() });
export type CastRecording = z.infer<typeof RecordingSchema>;

// POST /record/stop's answer for a recording castd wrote as it went: the file, in its `--record-dir`, and its length.
const RecordedSchema = z.object({ file: z.string(), bytes: z.number() });
export type CastRecorded = z.infer<typeof RecordedSchema>;

// POST /viewers/drop's answer: how many sockets castd ended.
const DroppedSchema = z.object({ dropped: z.number() });

// A screenshot as castd took it: the picture's PNG at display pixels (the crop's under `--crop`), and the change it
// includes, for a later wait to count from.
export interface CastShot {
    readonly png: Buffer;
    readonly seq: number | undefined;
}

// Past what castd waits itself, so its own timeout answers rather than this socket's.
const WAIT_SLACK_MS = 2_000;
// A pin, an unpin and a crop answer once the new size is in effect, castd waiting up to 3 s for it (server.rs
// APPLY_WITHIN): asked for longer, so a resize that is slow under load is not read as no castd at all, which a crop
// answers by starting castd again under every viewer.
const APPLY_MS = 3_000 + WAIT_SLACK_MS;
// Writing a recording's MP4 is a rewrap, not an encode: seconds even for castd's longest.
const RECORD_STOP_MS = 30_000;

export interface CastControl {
    readonly healthy: () => Promise<boolean>;
    readonly geometry: () => Promise<CastGeometry | undefined>;
    // The screen held at a size whatever viewers ask (a phone), and let go back to the driving viewer's box.
    readonly pin: (size: { readonly width: number; readonly height: number; readonly scale: number }) => Promise<boolean>;
    readonly unpin: () => Promise<boolean>;
    // Moves a cropped castd's rectangle live; false from a castd that cannot (none cropped, or one too old).
    readonly crop: (rect: CropRect) => Promise<boolean>;
    readonly screenshot: () => Promise<CastShot | undefined>;
    // Answers at the first change (`change`), or once nothing has changed for `quietMs` (counting from `since` when
    // given, else from the call), or at `timeoutMs`.
    readonly wait: (asked: { readonly quietMs?: number; readonly change?: boolean; readonly timeoutMs: number; readonly since?: number }) => Promise<CastWait | undefined>;
    // Starts a recording castd writes as it goes to `file`, a plain name in its `--record-dir`: no MP4 is ever held
    // whole, by castd or here.
    readonly recordStart: (file: string) => Promise<CastRecording | undefined>;
    // Ends it and answers where the MP4 of everything since the start is; undefined for an id castd no longer holds.
    readonly recordStop: (id: number) => Promise<CastRecorded | undefined>;
    // Ends every viewer's media socket (or only the read-write ones), and has castd refuse every such token minted
    // before now; answers how many it ended, undefined from a castd that did not answer.
    readonly dropViewers: (asked: { readonly reason: string; readonly readWrite?: boolean }) => Promise<number | undefined>;
}

export const castControl = (socket: string, ask: Ask): CastControl => {
    const post = async (path: string): Promise<boolean> => (await ask(socket, "POST", path, APPLY_MS))?.status === 200;
    return {
        healthy: async () => (await ask(socket, "GET", "/health"))?.status === 200,
        geometry: async () => {
            const answer = await ask(socket, "GET", "/geometry");
            return answer?.status === 200 ? parseJsonWith(answer.body, CastGeometrySchema) : undefined;
        },
        pin: ({ width, height, scale }) => post(`/pin?width=${Math.round(width)}&height=${Math.round(height)}&scale=${scale}`),
        unpin: () => post("/unpin"),
        crop: (rect) => post(`/crop?x=${rect.x}&y=${rect.y}&w=${rect.width}&h=${rect.height}`),
        screenshot: async () => {
            const answer = await ask(socket, "GET", "/screenshot", 6_000);
            if (answer?.status !== 200) {
                return undefined;
            }
            const seq = Number(answer.headers["x-castd-seq"]);
            return { png: answer.bytes, seq: Number.isFinite(seq) ? seq : undefined };
        },
        wait: async ({ quietMs, change, timeoutMs, since }) => {
            const query = new URLSearchParams({ timeout_ms: String(Math.round(timeoutMs)) });
            if (change === true) {
                query.set("change", "");
            } else {
                query.set("quiet_ms", String(Math.round(quietMs ?? 300)));
            }
            if (since !== undefined) {
                query.set("since", String(since));
            }
            const answer = await ask(socket, "GET", `/wait?${query.toString()}`, timeoutMs + WAIT_SLACK_MS);
            return answer?.status === 200 ? parseJsonWith(answer.body, CastWaitSchema) : undefined;
        },
        recordStart: async (file) => {
            const answer = await ask(socket, "POST", `/record/start?${new URLSearchParams({ file }).toString()}`);
            return answer?.status === 200 ? parseJsonWith(answer.body, RecordingSchema) : undefined;
        },
        recordStop: async (id) => {
            const answer = await ask(socket, "POST", `/record/stop?id=${id}`, RECORD_STOP_MS);
            return answer?.status === 200 ? parseJsonWith(answer.body, RecordedSchema) : undefined;
        },
        dropViewers: async ({ reason, readWrite }) => {
            const query = new URLSearchParams({ reason });
            if (readWrite === true) {
                query.set("read_write", "1");
            }
            const answer = await ask(socket, "POST", `/viewers/drop?${query.toString()}`);
            return answer?.status === 200 ? parseJsonWith(answer.body, DroppedSchema)?.dropped : undefined;
        },
    };
};
