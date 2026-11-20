import { browserContract } from "@intentic/sandbox-contract/contracts/browser.contract";
import { BrowserUploadQuerySchema } from "@intentic/sandbox-contract/schemas/browser-tools";
import { implement, ORPCError } from "@orpc/server";
import type { Context } from "hono";
import type { AppEnv, OrpcContext } from "../../app-env.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { decodedBody } from "../../http/request-body.js";
import { browserWindowRecord } from "../sessions/browser-sessions.js";
import { dropFiles } from "./drop.js";
import { answerFileChooser } from "./file-chooser.js";
import { UploadRefused, uploadedFiles, writeUploadPart } from "./upload-store.js";

// The routes that put the person's own files in front of a page: the upload itself (raw, streamed in parts like a
// workspace upload), then the answer to the page's file chooser, or the drop at a point, naming what was uploaded.

// The files uploaded under these ids, or the route's refusal naming the one missing.
const filesOf = async (ids: readonly string[]): Promise<string[]> => {
    try {
        return await uploadedFiles(ids);
    } catch (error) {
        if (error instanceof UploadRefused) {
            throw new ORPCError("NOT_FOUND", { message: error.message });
        }
        throw error;
    }
};

// The open page a window names, with its own DevTools session; a closed one is the caller's to hear about.
const openPage = (name: string, pageId: string) => {
    const entry = browserWindowRecord(name)?.pages.get(pageId);
    if (entry === undefined || entry.closed || entry.cdp === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "That tab is no longer open." });
    }
    return { page: entry.page, session: entry.cdp };
};

export const createUploadsRoutes = () => {
    const i = implement(browserContract).$context<OrpcContext>();
    return {
        // The chooser is looked up across the window's pages by its id: the window's state names one at a time.
        answerFileChooser: i.answerFileChooser.handler(async ({ input }) => {
            const record = browserWindowRecord(input.name);
            if (record === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That browser window is closed." });
            }
            const files = await filesOf(input.uploads ?? []);
            for (const entry of record.pages.values()) {
                if (!entry.closed && (await answerFileChooser(entry.page, input.chooser, files))) {
                    return { ok: true };
                }
            }
            throw new ORPCError("CONFLICT", { message: "That file chooser is no longer open." });
        }),
        dropFiles: i.dropFiles.handler(async ({ input }) => {
            const { page, session } = openPage(input.name, input.pageId);
            const files = await filesOf(input.uploads);
            await dropFiles(page, session, input.x, input.y, files);
            return { ok: true };
        }),
    };
};

/** POST /browser/uploads?id=&name=&offset=: one part of one file, into the uploads folder (upload-store.ts). */
const uploadRoute = async (c: Context<AppEnv>): Promise<Response> => {
    const query = BrowserUploadQuerySchema.safeParse({ id: c.req.query("id"), name: c.req.query("name") });
    if (!query.success) {
        return c.json({ error: "an upload names its id and its file's name" }, 400);
    }
    const decoded = decodedBody(c.req.raw.body, c.req.header("content-encoding"));
    if ("unsupported" in decoded) {
        return c.json({ error: `an upload cannot be sent in the ${decoded.unsupported} coding` }, 415);
    }
    try {
        await writeUploadPart({ id: query.data.id, name: query.data.name, offset: Number(c.req.query("offset") ?? 0), body: decoded.body });
    } catch (error) {
        if (error instanceof UploadRefused) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    }
    return c.json({ ok: true });
};

// Where a file for a page goes up, before the chooser's answer or the drop names it.
export const browserUploadsRawRoutes = defineRawRoutes(() => ({ "POST /browser/uploads": uploadRoute }));
