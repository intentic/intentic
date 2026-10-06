import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import type { OcrLine } from "@intentic/ocr/paddle-ocr";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import sharp from "sharp";
import type { OrpcContext } from "../app-env.js";
import { pesel } from "../privacy/detect/tests/ids.testing.js";
import { privacySliceFake } from "../privacy/privacy-slice.testing.js";
import type { LocalReaders } from "../privacy/readers.js";
import { createShareRoutes, type ShareRoutesDeps } from "./share.routes.js";
import { shareRoot, viewerDist } from "./share-publish.js";

// A conversation shared while the privacy shield is on: the page goes to the open internet whole, so nothing of the
// personal data may reach it, the pictures and their file names included. Against a real directory and the built page.

const viewerBuilt = (): boolean => {
    try {
        return existsSync(join(viewerDist(), "index.html"));
    } catch {
        // allow(silent-catch): an unresolvable page bundle is the answer: it is not built here.
        return false;
    }
};
const page = requires(viewerBuilt(), "the built shared-conversation page (@intentic/share-view)");

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/share/create" };
const VALUE = pesel(1985, 3, 14);
const WIDTH = 200;
const GREY = 128;

// One line, "PESEL <number>", across the middle of a grey picture, as the reader reports it.
const line = (text: string): OcrLine => {
    const chars = [...text];
    return {
        text,
        score: 0.99,
        corners: [
            { x: 0, y: 10 },
            { x: WIDTH, y: 10 },
            { x: WIDTH, y: 30 },
            { x: 0, y: 30 },
        ],
        chars: chars.map((char, index) => ({ char, from: index / chars.length, to: (index + 1) / chars.length })),
        column: 1 / chars.length,
        vertical: false,
    };
};

test.skipIf(!page.runs)(page.title("a share made while the shield is on publishes no personal data, in its pictures or their names"), async () => {
    const root = await mkdtemp(join(tmpdir(), "share-routes-"));
    const scan = await sharp({ create: { width: WIDTH, height: 40, channels: 3, background: { r: GREY, g: GREY, b: GREY } } })
        .png()
        .toBuffer();
    await mkdir(join(root, "clients"), { recursive: true });
    await writeFile(join(root, "clients", `scan-${VALUE}.png`), scan);
    await writeFile(join(root, "clients", "unreadable.png"), "NOT-AN-IMAGE");
    const readers: LocalReaders = {
        ocr: async () => true,
        readImage: async (data) => (data.equals(scan) ? { width: WIDTH, height: 40, lines: [line(`PESEL ${VALUE}`)] } : undefined),
        readPdf: async () => undefined,
    };
    const { privacyShield } = privacySliceFake({ policy: { mode: "on" }, readers });
    const rows: TranscriptRow[] = [
        { role: "user", text: `here is the scan for PESEL ${VALUE}`, attachments: [`clients/scan-${VALUE}.png`] },
        {
            role: "assistant",
            text: "Read it.",
            tools: [
                {
                    id: "t1",
                    name: "Read",
                    category: "read",
                    status: "completed",
                    locations: [{ path: `clients/scan-${VALUE}.png` }],
                    content: [{ type: "image", path: "clients/unreadable.png" }],
                },
            ],
        },
    ];
    const services: ShareRoutesDeps = {
        agents: unstubbed<ShareRoutesDeps["agents"]>("agents", { entry: (id) => (id === "c1" ? unstubbed("agent", {}) : undefined) }),
        config: unstubbed<ShareRoutesDeps["config"]>("config", { zone: "", sandbox: unstubbed("sandbox", { publicUrl: "" }), connectToken: "" }),
        privacyShield,
        shares: unstubbed<ShareRoutesDeps["shares"]>("shares", { put: async () => undefined }),
        transcripts: unstubbed<ShareRoutesDeps["transcripts"]>("transcripts", { read: async () => rows }),
        workspace: unstubbed<ShareRoutesDeps["workspace"]>("workspace", { root }),
    };

    const share = await call(createShareRoutes(services).create, { conversationId: "c1", title: "Scan", detail: "everything" }, { context });

    const dir = join(shareRoot(root), share.id);
    const files = await readdir(join(dir, "files"));
    // The readable scan, painted; the one the reader could not read is not published at all.
    expect(files).toEqual(["1.png"]);
    expect((await readFile(join(dir, "index.html"), "utf8")).includes(VALUE)).toBe(false);
    const { data, info } = await sharp(join(dir, "files", "1.png"))
        .raw()
        .toBuffer({ resolveWithObject: true });
    // The label as it was; where the number was, white.
    expect(data[(20 * info.width + 10) * info.channels]).toBe(GREY);
    expect(data[(11 * info.width + 150) * info.channels]).toBe(255);
});
