import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { readPageMedia } from "@intentic/sandbox-contract/text/pages";
import { unstubbed } from "@intentic/testing";
import type { AppEnv } from "../../app-env.js";
import { createMediaTickets } from "../../auth/tokens/media-tickets.js";
import { serveRawRoutes } from "../../http/raw-route-server.js";
import { carryPage } from "./page-assets.js";
import { pageMediaKeyPath } from "./page-media.js";
import { pageMediaBinding, pageMediaRawRoutes, type PageMediaRoutesDeps } from "./page-media.routes.js";
import { publishPage } from "./page-store.js";

// A shown page's video and audio, from the moment it is shown to the reader's player seeking in it: carried as a
// reference and a manifest (page-assets.ts, page-store.ts), then streamed in ranges under a ticket bound to the page
// (page-media.routes.ts). Real files, a real ticket store, the real route.

// An MP4's opening box, then bytes that number their own positions, so a range's answer can be checked byte for byte.
const mp4 = (length: number): Buffer => {
    const bytes = Buffer.alloc(length);
    bytes.write("\0\0\0\x18ftypisom\0\0\x02\0isommp41", 0, "latin1");
    for (let at = 24; at < length; at += 1) {
        bytes[at] = at % 251;
    }
    return bytes;
};
const MP3 = Buffer.from("ID3\x04\0\0\0\0\0\0rest-of-an-mp3", "latin1");

describe("a page's video and audio", () => {
    let root: string;
    let history: string;
    let outside: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "page-media-"));
        history = mkdtempSync(join(tmpdir(), "page-media-history-"));
        outside = mkdtempSync(join(tmpdir(), "page-media-outside-"));
        mkdirSync(join(root, "shots"), { recursive: true });
        writeFileSync(join(root, "shots", "take1.mp4"), mp4(4096));
        writeFileSync(join(root, "shots", "take2.mp4"), mp4(2048));
        writeFileSync(join(root, "shots", "voice.mp3"), MP3);
        writeFileSync(join(root, "shots", "notes.mp4"), "these are notes, not a video");
        writeFileSync(join(root, "shots", "clip.avi"), "RIFF....AVI ");
        writeFileSync(join(outside, "secret.mp4"), mp4(512));
        symlinkSync(join(outside, "secret.mp4"), join(root, "shots", "linked.mp4"));
    });
    afterEach(() => {
        for (const dir of [root, history, outside]) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The places the tool carries from: the workspace, for pictures and for media alike.
    const context = () => ({ baseDir: join(root, "shots"), roots: [root], mediaRoots: [root] });

    describe("when shown", () => {
        it("records each file the players and the page's scripts name, once, and leaves its reference in its place", async () => {
            const html =
                `<video src="take1.mp4" poster="none.png" controls crossorigin="anonymous"></video>` +
                `<audio controls><source src="${join(root, "shots", "voice.mp3")}" type="audio/mpeg"></audio>` +
                `<script>const takes=["${join(root, "shots", "take1.mp4")}","${join(root, "shots", "take2.mp4")}"]</script>`;
            const carried = await carryPage(html, context());
            expect(carried.html).toContain(`<video src="intentic-media:0"`);
            expect(carried.html).not.toContain("crossorigin");
            expect(carried.html).toContain(`<source src="intentic-media:1" type="audio/mpeg">`);
            expect(carried.html).toContain(`const takes=["intentic-media:0","intentic-media:2"]`);
            expect(carried.media.map((file) => [file.path, file.type, file.size])).toEqual([
                [join(root, "shots", "take1.mp4"), "video/mp4", 4096],
                [join(root, "shots", "voice.mp3"), "audio/mpeg", MP3.length],
                [join(root, "shots", "take2.mp4"), "video/mp4", 2048],
            ]);
            expect(carried.mediaNamed).toEqual(["take1.mp4", join(root, "shots", "voice.mp3"), join(root, "shots", "take2.mp4")]);
            expect(carried.mediaRefused).toEqual([]);
        });

        it("refuses, by name and reason, a file that is not what its name says, one a link takes outside, one not there, and a format no browser plays", async () => {
            const carried = await carryPage(
                `<video src="notes.mp4"></video><video src="linked.mp4"></video><video src="gone.mp4"></video><video src="clip.avi"></video>`,
                context(),
            );
            expect(carried.media).toEqual([]);
            const reasons = Object.fromEntries(carried.mediaRefused.map((refused) => [refused.ref, refused.reason]));
            expect(reasons["notes.mp4"]).toContain("bytes are not MP4");
            expect(reasons["linked.mp4"]).toContain("outside the workspace and your own checkout");
            expect(reasons["gone.mp4"]).toBe("no such file");
            expect(reasons["clip.avi"]).toContain("not a video or audio format");
            // Nothing refused is ever named twice, as missing as well.
            expect(carried.missing).toEqual([]);
        });

        it("streams media only from its own places, never from one pictures may still come from (the daemon's /tmp)", async () => {
            writeFileSync(join(outside, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
            const carried = await carryPage(`<img src="${join(outside, "dot.png")}"><video src="${join(outside, "secret.mp4")}"></video>`, {
                ...context(),
                roots: [root, outside],
            });
            expect(carried.html).toContain(`<img src="data:image/png;base64,`);
            expect(carried.media).toEqual([]);
            expect(carried.mediaRefused.map((refused) => refused.ref)).toEqual([join(outside, "secret.mp4")]);
        });

        it("drops a manifest the page wrote itself, so only the daemon's is ever read", async () => {
            const forged = `<script type="application/json" id="intentic-page-media">[{"path":"/etc/shadow","type":"video/mp4","size":1,"mtimeMs":1}]</script>`;
            const carried = await carryPage(`${forged}<p>x</p>`, context());
            expect(carried.html).not.toContain(`id="intentic-page-media"`);
            expect(readPageMedia(carried.html)).toBeUndefined();
        });
    });

    // The page shown with its two takes, filed and signed as the tool files it, and the route over a real ticket store.
    // `stored` files another page of `conversation` naming `media` as given, signed by the daemon's own key: a manifest
    // carrying could never record, to show what the route still refuses of one it did sign.
    const shown = async () => {
        const mediaKey = pageMediaKeyPath(history);
        const carried = await carryPage(`<video src="take1.mp4" controls></video><video src="take2.mp4" controls></video>`, context());
        const page = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "Takes", html: carried.html, media: carried.media, mediaKey });
        const tickets = createMediaTickets();
        const app = serveRawRoutes(
            new Hono<AppEnv>(),
            pageMediaRawRoutes(
                unstubbed<PageMediaRoutesDeps>("page media", {
                    workspace: unstubbed<PageMediaRoutesDeps["workspace"]>("workspace", { root }),
                    config: unstubbed<PageMediaRoutesDeps["config"]>("config", { historyRoot: history }),
                    mediaTickets: tickets,
                }),
            ),
        );
        const { ticket } = tickets.mint(pageMediaBinding(page.path));
        const stored = async (conversation: string, media: Parameters<typeof publishPage>[0]["media"]) => {
            const forged = await publishPage({ workspaceRoot: root, conversationId: conversation, title: "Forged", html: "<video src='intentic-media:0'></video>", media, mediaKey });
            return { path: forged.path, ticket: tickets.mint(pageMediaBinding(forged.path)).ticket };
        };
        return { page, tickets, ticket, stored, app };
    };

    // Every answer read to its end: the route streams from a file it holds open, and a body nobody reads keeps that file
    // open until the garbage collector closes it, which Bun throws for in whatever test is running then. That was the
    // intermittent failure, in a different test each time.
    const get = async (app: Hono<AppEnv>, path: string, range?: string) => {
        const response = await app.request(path, range === undefined ? {} : { headers: { range } });
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, body, text: body.toString("utf8") };
    };
    const infoOf = async (path: string) => {
        const info = await Bun.file(path).stat();
        return { path, type: "video/mp4", size: info.size, mtimeMs: info.mtimeMs };
    };

    describe("when played", () => {
        it("answers a range with 206 and exactly those bytes of the file the page named", async () => {
            const { app, ticket } = await shown();
            const first = await get(app, `/pages/media/${ticket}/0`, "bytes=100-199");
            expect(first.status).toBe(206);
            expect(first.headers.get("content-type")).toBe("video/mp4");
            expect(first.headers.get("accept-ranges")).toBe("bytes");
            expect(first.headers.get("content-range")).toBe("bytes 100-199/4096");
            expect(first.body.equals(mp4(4096).subarray(100, 200))).toBe(true);
            const second = await get(app, `/pages/media/${ticket}/1`, "bytes=-24");
            expect(second.status).toBe(206);
            expect(second.body.equals(mp4(2048).subarray(2024))).toBe(true);
        });

        it("serves nothing the page did not name: an index past its manifest, a path in place of one, an unknown ticket, a ticket for something else", async () => {
            const { app, ticket, tickets } = await shown();
            expect((await get(app, `/pages/media/${ticket}/2`)).status).toBe(404);
            expect((await get(app, `/pages/media/${ticket}/${encodeURIComponent(join(root, "shots", "voice.mp3"))}`)).status).toBe(404);
            expect((await get(app, `/pages/media/${ticket}/-1`)).status).toBe(404);
            expect((await get(app, `/pages/media/not-a-ticket/0`)).status).toBe(401);
            const other = tickets.mint(join(root, "shots", "take1.mp4")).ticket;
            expect((await get(app, `/pages/media/${other}/0`)).status).toBe(401);
        });

        it("refuses a file overwritten after the page was shown, rather than playing another take in its place", async () => {
            const { app, ticket } = await shown();
            writeFileSync(join(root, "shots", "take1.mp4"), mp4(4096));
            utimesSync(join(root, "shots", "take1.mp4"), new Date(), new Date(Date.now() + 5000));
            const changed = await get(app, `/pages/media/${ticket}/0`, "bytes=0-9");
            expect(changed.status).toBe(409);
            expect(changed.text).toContain("changed after the page was shown");
            // The other take, untouched, still plays.
            expect((await get(app, `/pages/media/${ticket}/1`, "bytes=0-9")).status).toBe(206);
        });

        it("serves only a manifest the daemon signed for that very page: one edited in the records, or copied to another page, is refused", async () => {
            const { app, page, ticket, stored } = await shown();
            // Copied whole into another page of the same conversation: signed, but for the page it came from.
            const other = await stored("conv-1", [await infoOf(join(root, "shots", "take2.mp4"))]);
            const file = join(root, other.path);
            writeFileSync(file, readFileSync(file, "utf8").replace(/<script type="application\/json" id="intentic-page-media">[\s\S]*?<\/script>/, readFileSync(join(root, page.path), "utf8").match(/<script type="application\/json" id="intentic-page-media">[\s\S]*?<\/script>/)?.[0] ?? ""));
            expect((await get(app, `/pages/media/${other.ticket}/0`, "bytes=0-9")).status).toBe(404);
            // Edited in place: the shown page's manifest pointed at another file.
            const shownFile = join(root, page.path);
            writeFileSync(shownFile, readFileSync(shownFile, "utf8").replace(join(root, "shots", "take1.mp4"), join(root, "shots", "voice.mp3")));
            expect((await get(app, `/pages/media/${ticket}/0`, "bytes=0-9")).status).toBe(404);
        });

        it("serves from the workspace and the showing conversation's own checkout, and says the same 404 for anywhere else as for nothing at all", async () => {
            const { app, ticket, stored } = await shown();
            const own = join(history, "worktrees", "conv-1", "renders");
            const another = join(history, "worktrees", "conv-2", "renders");
            mkdirSync(own, { recursive: true });
            mkdirSync(another, { recursive: true });
            writeFileSync(join(own, "take.mp4"), mp4(1024));
            writeFileSync(join(another, "take.mp4"), mp4(1024));
            const mine = await stored("conv-1", [await infoOf(join(own, "take.mp4"))]);
            expect((await get(app, `/pages/media/${mine.ticket}/0`, "bytes=0-9")).status).toBe(206);
            const theirs = await stored("conv-1", [await infoOf(join(another, "take.mp4"))]);
            const elsewhere = await stored("conv-1", [await infoOf(join(outside, "secret.mp4"))]);
            const gone = await stored("conv-1", [{ path: join(root, "shots", "gone.mp4"), type: "video/mp4", size: 1, mtimeMs: 1 }]);
            const answers = await Promise.all([
                get(app, `/pages/media/${theirs.ticket}/0`),
                get(app, `/pages/media/${elsewhere.ticket}/0`),
                get(app, `/pages/media/${gone.ticket}/0`),
                get(app, `/pages/media/${ticket}/7`),
            ]);
            expect(new Set(answers.map((answer) => `${answer.status} ${answer.text}`)).size).toBe(1);
            expect(answers[0]?.status).toBe(404);
        });

        it("refuses a non-media file a signed manifest names under a media name, and a link that leads elsewhere", async () => {
            const { app, stored } = await shown();
            const notes = await stored("conv-1", [await infoOf(join(root, "shots", "notes.mp4"))]);
            expect((await get(app, `/pages/media/${notes.ticket}/0`)).status).toBe(415);
            const linked = await stored("conv-1", [await infoOf(join(root, "shots", "linked.mp4"))]);
            expect((await get(app, `/pages/media/${linked.ticket}/0`)).status).toBe(404);
        });

        it("serves a file as the type its name says, whatever type a signed manifest gives it", async () => {
            const { app, stored } = await shown();
            const take = await stored("conv-1", [{ ...(await infoOf(join(root, "shots", "take2.mp4"))), type: "text/html" }]);
            const response = await get(app, `/pages/media/${take.ticket}/0`, "bytes=0-9");
            expect(response.status).toBe(206);
            expect(response.headers.get("content-type")).toBe("video/mp4");
        });
    });
});
