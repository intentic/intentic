import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type PageMediaFile, pageMediaScript } from "@intentic/sandbox-contract/text/pages";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { pageMediaKeyPath, signPageMedia } from "../../workspace/files/stored/stored-page-media.js";
import { ARTIFACT_CHUNK_BYTES, ARTIFACTS_DIR, sha256Of } from "../../workspace/files/stored/stored-artifacts.js";
import { PAGES_DIR } from "../../workspace/files/stored/stored-pages.js";
import { type FileDoorDeps, listArtifactsDoor, readArtifactDoor, readPageMediaDoor } from "./runner-file-doors.js";
import { replyHere, steerHere } from "../runner-service.js";
import { INLINE_FILE_MAX_BYTES, inlineFiles } from "./runner-files.js";

/* What a runner serves its parent and writes for it, on real files: a picture in a conversation's own checkout, the
   files a turn left in the artifacts folder (in pieces past one frame), a page's video only under a manifest the runner
   itself signed, and the files a steer or an answer carries. */

let root: string;
let history: string;
let outside: string;
let deps: FileDoorDeps;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "runner-doors-"));
    history = await mkdtemp(join(tmpdir(), "runner-doors-history-"));
    outside = await mkdtemp(join(tmpdir(), "runner-doors-outside-"));
    deps = { workspaceRoot: root, historyRoot: history, checkoutOf: (id) => join(history, "worktrees", id) };
});

afterEach(async () => {
    for (const dir of [root, history, outside]) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a picture in a conversation's checkout is served from that checkout, and nothing outside it is", async () => {
    const checkout = deps.checkoutOf("c1");
    await mkdir(join(checkout, "docs"), { recursive: true });
    await writeFile(join(checkout, "docs", "diagram.png"), "pixels");
    await writeFile(join(outside, "secret.png"), "not ours");
    await symlink(join(outside, "secret.png"), join(checkout, "docs", "linked.png"));
    const answer = await readArtifactDoor(deps, { path: "docs/diagram.png", conversationId: "c1" });
    expect(Buffer.from(answer.bytesBase64 ?? "", "base64").toString()).toBe("pixels");
    for (const input of [
        { path: "docs/linked.png", conversationId: "c1" },
        { path: "../../../secret.png", conversationId: "c1" },
        { path: "docs/diagram.png", conversationId: "../c1" },
        // Without the conversation, a checkout path names nothing in the artifacts folder.
        { path: "docs/diagram.png" },
    ]) {
        await expect(readArtifactDoor(deps, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
});

test("a file is served in pieces with its whole size, and a parent holding it already gets no bytes", async () => {
    const path = `${ARTIFACTS_DIR}renders/take.bin`;
    const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES + 5, 3);
    await mkdir(join(root, ARTIFACTS_DIR, "renders"), { recursive: true });
    await writeFile(join(root, path), bytes);
    const first = await readArtifactDoor(deps, { path, offset: 0, length: ARTIFACT_CHUNK_BYTES * 4 });
    expect(first.size).toBe(bytes.length);
    expect(Buffer.from(first.bytesBase64 ?? "", "base64")).toHaveLength(ARTIFACT_CHUNK_BYTES);
    const rest = await readArtifactDoor(deps, { path, offset: ARTIFACT_CHUNK_BYTES, length: ARTIFACT_CHUNK_BYTES });
    expect(Buffer.from(rest.bytesBase64 ?? "", "base64")).toHaveLength(5);
    expect(await readArtifactDoor(deps, { path, offset: 0, length: 10, have: sha256Of(bytes) })).toEqual({ size: bytes.length });
    // Asked whole, as an older parent asks, it is past one frame only beyond the frame's cap.
    expect(Buffer.from((await readArtifactDoor(deps, { path })).bytesBase64 ?? "", "base64")).toHaveLength(bytes.length);
});

test("the artifacts a turn left are listed by when they changed, the person's uploads, pages and parents' copies left out", async () => {
    const write = async (rel: string, mtime: number): Promise<void> => {
        await mkdir(join(root, ARTIFACTS_DIR, rel, ".."), { recursive: true });
        await writeFile(join(root, ARTIFACTS_DIR, rel), rel);
        await utimes(join(root, ARTIFACTS_DIR, rel), mtime / 1000, mtime / 1000);
    };
    const now = Date.now();
    await write("evidence/report.pdf", now - 1000);
    await write("old/trace.zip", now - 3_600_000);
    await write("attachments/a/upload.png", now);
    await write("pages/c1/0123456789.r0.html", now);
    await write("runner/c9/docs/x.png", now);
    const { files } = await listArtifactsDoor(deps, { withinMs: 60_000 });
    expect(files.map((file) => file.path)).toEqual([`${ARTIFACTS_DIR}evidence/report.pdf`]);
    expect(files[0]?.size).toBe("evidence/report.pdf".length);
});

test("a page's media is served only under a manifest this runner signed for that page, and only while the file is unchanged", async () => {
    const take = join(root, "take.mp4");
    await writeFile(take, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(100, 2)]));
    const info = await stat(take);
    const file: PageMediaFile = { path: take, type: "video/mp4", size: info.size, mtimeMs: info.mtimeMs };
    const page = `${PAGES_DIR}c1/0123456789.r0.html`;
    const forged = `${PAGES_DIR}c1/abcdefabcd.r0.html`;
    await mkdir(join(root, PAGES_DIR, "c1"), { recursive: true });
    const signed = await signPageMedia(pageMediaKeyPath(history), page, [file]);
    await writeFile(join(root, page), `<video src="intentic-media:0"></video>${pageMediaScript(signed)}`);
    // The same manifest copied into another page does not verify there.
    await writeFile(join(root, forged), `<video src="intentic-media:0"></video>${pageMediaScript(signed)}`);

    const piece = await readPageMediaDoor(deps, { page, index: 0, offset: 4, length: 8 });
    expect(Buffer.from(piece.bytesBase64, "base64").toString()).toBe("ftypisom");
    expect(piece.size).toBe(info.size);
    await expect(readPageMediaDoor(deps, { page: forged, index: 0, offset: 0, length: 8 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readPageMediaDoor(deps, { page, index: 1, offset: 0, length: 8 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await writeFile(take, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200, 2)]));
    await expect(readPageMediaDoor(deps, { page, index: 0, offset: 0, length: 8 })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

describe("a steer and an answer carrying files", () => {
    const servicesWith = (record: unknown[]) =>
        unstubbed<Services>("services", {
            workspace: unstubbed<Services["workspace"]>("workspace", { root }),
            turns: unstubbed<Services["turns"]>("turns", {
                steer: async (conversationId, steer) => {
                    record.push({ conversationId, ...steer });
                    return true;
                },
                reply: async (reply) => {
                    record.push(reply);
                    return "settled";
                },
            }),
        });
    const upload = `${ARTIFACTS_DIR}attachments/u1/shot.png`;
    const bytesBase64 = Buffer.from("the person's screenshot").toString("base64");

    test("a steer writes its files before it applies, in the voice the parent names, the person's by default", async () => {
        const record: unknown[] = [];
        const services = servicesWith(record);
        expect(await steerHere(services, { conversationId: "c1", text: "also this", attachments: [upload], files: [{ path: upload, bytesBase64 }] })).toEqual({
            applied: true,
        });
        expect(await readFile(join(root, upload), "utf8")).toBe("the person's screenshot");
        await steerHere(services, { conversationId: "c1", text: "your subagent finished", voice: "agent", outside: "github" });
        expect(record).toMatchObject([
            { conversationId: "c1", text: "also this", voice: "person", attachments: [upload] },
            { conversationId: "c1", text: "your subagent finished", voice: "agent", outside: "github" },
        ]);
    });

    test("a steer whose file climbs out of the workspace is refused, and nothing is written or said", async () => {
        const record: unknown[] = [];
        const answer = await steerHere(servicesWith(record), { conversationId: "c1", text: "x", files: [{ path: "../escape.txt", bytesBase64 }] });
        expect(answer.applied).toBe(false);
        expect(answer.invalid).toContain("escapes the workspace");
        expect(record).toEqual([]);
        await expect(readFile(join(root, "..", "escape.txt"))).rejects.toThrow();
    });

    test("an answer writes the files it attaches before it applies, and the answer goes on without them", async () => {
        const record: unknown[] = [];
        const answer = await replyHere(servicesWith(record), {
            kind: "question",
            requestId: "q1",
            answers: { "Which one?": ["this"] },
            attachments: { "Which one?": [upload] },
            files: [{ path: upload, bytesBase64 }],
        });
        expect(answer).toEqual({ applied: true });
        expect(await readFile(join(root, upload), "utf8")).toBe("the person's screenshot");
        expect(record).toEqual([{ kind: "question", requestId: "q1", answers: { "Which one?": ["this"] }, attachments: { "Which one?": [upload] } }]);
    });
});

// Review, 2026-11-23: the parent read what a steer or an answer named with no containment and followed links, so a
// mention of `../../history/<file>`, or a link inside the workspace into the history, shipped that file to the runner.
test("the files a message names are read only inside the workspace, links resolved, and only up to the caps", async () => {
    const warn = (): void => undefined;
    await writeFile(join(outside, "secret.txt"), "not the runner's to see");
    await writeFile(join(root, "notes.md"), "ours");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    const big = join(root, "big.bin");
    await writeFile(big, "");
    await truncate(big, INLINE_FILE_MAX_BYTES + 1);
    const escape = relative(root, join(outside, "secret.txt"));

    // An escaping mention, or one through a link, is dropped; the rest still goes.
    expect(await inlineFiles(root, { warn }, { mentions: ["notes.md", escape, "linked.txt"] })).toEqual({
        files: [{ path: "notes.md", bytesBase64: Buffer.from("ours").toString("base64") }],
    });
    // An escaping attachment refuses the message, whether spelled out or through a link.
    expect(await inlineFiles(root, { warn }, { attachments: [escape] })).toEqual({ invalid: `invalid attachment path: ${escape}` });
    expect(await inlineFiles(root, { warn }, { attachments: ["linked.txt"] })).toEqual({ invalid: "invalid attachment path: linked.txt" });
    // Past the cap a file stays behind, sized before it is read.
    expect(await inlineFiles(root, { warn }, { attachments: ["big.bin"] })).toEqual({ files: undefined });
});
