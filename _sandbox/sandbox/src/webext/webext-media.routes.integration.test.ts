import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { WEBEXT_MEDIA_MAX_BYTES } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import { WebExtFileRefusalSchema, WebExtMediaAnswerSchema } from "@intentic/sandbox-contract/schemas/webext";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { Hono } from "hono";
import type { Services } from "../composition.js";
import type { Presented } from "../peers/enrollment.js";
import { createFileTickets } from "./file-tickets.js";
import { CHROME_MEDIA_REL, safeStem } from "./media-shelf.js";
import { createWebExtFileRoute, createWebExtMediaRoute } from "./webext.routes.js";

// The two doors a file crosses between the owner's own browser and this sandbox, on the browser's enrollment token:
// POST /system/webext/media stores what the agent saved from a page onto the artifacts shelf, and POST
// /system/webext/file hands one shelf file back for a ticket the daemon added to the agent's `upload_file` call.

const TOKENS = new Map<string, Presented>([
    ["iwx_chrome", { kind: "enrolled", id: "chrome", card: "chrome" }],
    ["iwx_brave", { kind: "enrolled", id: "brave", card: "brave" }],
]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// The stored file's place, or the test fails with the door's own sentence.
const savedPath = async (response: Response): Promise<string> => {
    const answer = WebExtMediaAnswerSchema.parse(await response.json());
    if (!answer.ok) {
        throw new Error(answer.message);
    }
    return answer.path;
};
const UploadCallSchema = z.object({ params: z.object({ arguments: z.object({ ticket: z.string(), path: z.string(), ref: z.string() }) }) });

let root = "";
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "webext-media-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const stage = () => {
    const logged: string[] = [];
    const fileTickets = createFileTickets();
    const deps = {
        webexts: unstubbed<Services["webexts"]>("webexts", { verify: async (token) => TOKENS.get(token) ?? { kind: "unknown" } }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", {
            info: (...args: unknown[]) => {
                logged.push(JSON.stringify(args));
            },
        }),
        fileTickets,
    };
    const app = new Hono();
    app.post("/system/webext/media", createWebExtMediaRoute(deps));
    app.post("/system/webext/file", createWebExtFileRoute(deps));
    const save = async (body: BodyInit, headers: Record<string, string>, token = "iwx_chrome") =>
        await app.request("/system/webext/media", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body });
    const collect = async (ticket: string, token = "iwx_chrome") =>
        await app.request("/system/webext/file", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ticket }),
        });
    // The agent's call as the daemon sees it on its way to the browser, and the ticket it goes on with.
    const upload = async (path: string, card = "chrome") => {
        const routed = await fileTickets.route(card, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upload_file", arguments: { ref: "e3", path, ticket: "made-up" } } }, root);
        if (routed === undefined || "refusal" in routed) {
            return { refusal: routed === undefined ? "not routed" : routed.refusal };
        }
        const { arguments: args } = UploadCallSchema.parse(routed.message).params;
        return { ticket: args.ticket, args };
    };
    return { logged, save, collect, upload, fileTickets };
};

test("a saved picture lands on the shelf under chrome/, named safely, and the answer says where", async () => {
    const staged = stage();
    const response = await staged.save(PNG, { "content-type": "image/png", "x-intentic-name": encodeURIComponent("Generated image 1 <b>"), "x-intentic-source": "chatgpt.com" });
    expect(response.status).toBe(200);
    const answer = WebExtMediaAnswerSchema.parse(await response.json());
    expect(answer).toEqual({ ok: true, path: join(root, CHROME_MEDIA_REL, "Generated-image-1-b.png"), bytes: PNG.byteLength, mimeType: "image/png" });
    expect(new Uint8Array(await readFile(join(root, CHROME_MEDIA_REL, "Generated-image-1-b.png")))).toEqual(PNG);
    // A second save of the same name never takes the first one's place.
    expect(await savedPath(await staged.save(PNG, { "content-type": "image/png", "x-intentic-name": "Generated%20image%201%20%3Cb%3E" }))).toBe(join(root, CHROME_MEDIA_REL, "Generated-image-1-b-2.png"));
    expect(staged.logged.join("\n")).toContain(`"source":"chatgpt.com"`);
});

test("a type the sandbox does not know is stored as .bin, and a page's name cannot climb out of the folder", async () => {
    const staged = stage();
    expect(await savedPath(await staged.save(PNG, { "content-type": "application/x-thing", "x-intentic-name": encodeURIComponent("../../secrets/x") }))).toBe(join(root, CHROME_MEDIA_REL, "secrets-x.bin"));
    expect(safeStem("")).toBe("media");
    expect(safeStem("…")).toBe("media");
});

test("the media door turns away a stranger, a body with no type, an empty one and one past the cap", async () => {
    const staged = stage();
    expect((await staged.save(PNG, { "content-type": "image/png" }, "iwx_nobody")).status).toBe(401);
    expect((await staged.save(PNG, { "content-type": "not a type" })).status).toBe(400);
    expect((await staged.save(new Uint8Array(), { "content-type": "image/png" })).status).toBe(400);
    const tooLarge = await staged.save(new Uint8Array(WEBEXT_MEDIA_MAX_BYTES + 1), { "content-type": "image/png" });
    expect(tooLarge.status).toBe(413);
    expect(WebExtMediaAnswerSchema.parse(await tooLarge.json())).toEqual({ ok: false, message: expect.stringContaining("50 MB") });
});

test("a shelf file is released once, for the browser its ticket was minted for, with its name and type", async () => {
    const staged = stage();
    const dir = join(root, `${STATE_DIR}/records/artifacts/chrome`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "frame.png"), PNG);
    const minted = await staged.upload(`${STATE_DIR}/records/artifacts/chrome/frame.png`);
    if (minted.ticket === undefined) {
        throw new Error(minted.refusal);
    }
    // The agent's own `ticket` is replaced by one the daemon minted; the rest goes on as it came.
    expect(minted.ticket).not.toBe("made-up");
    expect(minted.args.ref).toBe("e3");

    // Another browser presenting it burns it for nobody's benefit.
    const wrong = await staged.collect(minted.ticket, "iwx_brave");
    expect(wrong.status).toBe(403);
    expect(WebExtFileRefusalSchema.parse(await wrong.json()).message).toBe("That ticket was issued to another browser.");

    const again = await staged.upload(join(root, `${STATE_DIR}/records/artifacts/chrome/frame.png`));
    const response = await staged.collect(again.ticket ?? "");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-intentic-name")).toBe("frame.png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(staged.logged.join("\n")).not.toContain(again.ticket);
    // One ticket, one collection.
    expect((await staged.collect(again.ticket ?? "")).status).toBe(404);
});

test("a file off the shelf, or a link on it that leads out, is refused before the browser hears of it", async () => {
    const staged = stage();
    await mkdir(join(root, `${STATE_DIR}/secrets`), { recursive: true });
    await writeFile(join(root, `${STATE_DIR}/secrets/token`), "s3cret");
    expect((await staged.upload(`${STATE_DIR}/secrets/token`)).refusal).toContain("is not on the artifacts shelf");
    expect((await staged.upload(`${STATE_DIR}/records/artifacts/../../secrets/token`)).refusal).toContain("is not on the artifacts shelf");
    const shelf = join(root, `${STATE_DIR}/records/artifacts/attachments`);
    await mkdir(shelf, { recursive: true });
    await symlink(join(root, `${STATE_DIR}/secrets/token`), join(shelf, "innocent.png"));
    expect((await staged.upload(`${STATE_DIR}/records/artifacts/attachments/innocent.png`)).refusal).toContain("is not on the artifacts shelf");
    expect((await staged.upload(`${STATE_DIR}/records/artifacts/attachments/missing.png`)).refusal).toContain("There is no file");
    // Every other message to the browser goes on untouched.
    expect(await staged.fileTickets.route("chrome", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: { ref: "e1" } } }, root)).toBeUndefined();
    expect(await staged.fileTickets.route("chrome", { jsonrpc: "2.0", id: 3, method: "tools/list" }, root)).toBeUndefined();
});

test("a ticket nobody minted, or an unreadable request, is refused at the file door", async () => {
    const staged = stage();
    expect((await staged.collect("guessed")).status).toBe(404);
    const unreadable = await stage().collect("");
    expect(unreadable.status).toBe(400);
});
