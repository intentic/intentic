import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import {
    WEBEXT_MEDIA_MAX_BYTES,
    WEBEXT_MEDIA_NAME_HEADER,
    WEBEXT_UPLOAD_TOOL,
    WebExtFileRefusalSchema,
    webextFileUrl,
} from "@intentic/sandbox-contract/webext";
// Named imports, as in mcp.ts: the `z` namespace would keep zod's locales in the bundle.
import { number, object, string } from "zod";
import { findFileInput, mediaOfRef, putFile, receiveFileSlice } from "../../page/media-driver.js";
import { askPerson } from "../asking.js";
import { RefusedError } from "../policy.js";
import { type SandboxKey, store } from "../store.js";
import { megabytes, saveMediaFromTab, toBase64 } from "./media.js";
import { announce, inject, snapshot } from "./page.js";
import { type TargetTab, targetTab } from "./tab-access.js";

// The agent's two tools for files: `save_media` brings a picture, video or file it sees on a page into the sandbox, and
// `upload_file` puts a sandbox file into a page's file input. Bytes never ride a tool answer either way (media.ts).

// How long the person has to answer before a file goes to a site; unanswered is no, as for every question here.
const CONFIRM_TIMEOUT_MS = 120_000;
// One slice into the page per call, as media.ts reads them out.
const SLICE_BYTES = 4 * 1024 * 1024;

const required = string().min(1);
const tab = number().int().optional().describe("Which tab, from `tabs`. Omit for your own tab, the one `open` loaded.");

// A name stem from an address, for a file the agent did not name: the last part of its path, else "media".
const stemOfUrl = (url: string): string => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? decodeURIComponent(parsed.pathname.split("/").pop() ?? "") : "";
        // allow(silent-catch): an address that does not parse names nothing, and the sandbox's own default names the file
    } catch {
        return "";
    }
};

// The tab for a save by url, with why it needs act when only read is allowed.
const actingTab = async (from: SandboxKey, tabId: number | undefined): Promise<TargetTab> => {
    try {
        return await targetTab(from, "act", tabId);
    } catch (error) {
        if (error instanceof RefusedError) {
            throw new RefusedError(
                `${error.message} Saving by url needs act on the site, since the address is fetched with its sign-in; to keep what the page shows, save it by its ref, which needs only read.`,
            );
        }
        throw error;
    }
};

const saveMedia = async (from: SandboxKey, what: { readonly ref: string | undefined; readonly url: string | undefined; readonly name: string | undefined }, tabId?: number): Promise<string> => {
    // A ref saves what the page already shows, so reading is enough. An address is fetched with the site's own sign-in
    // and could be any of its answers, not just one on screen: that is acting on the site, and keptFromAddress
    // (media.ts) narrows what it may bring in.
    const target = what.ref === undefined ? await actingTab(from, tabId) : await targetTab(from, "read", tabId);
    let address: string;
    let label = "";
    if (what.ref !== undefined) {
        const media = await inject(target.id, mediaOfRef, [what.ref]);
        if (!media.ok) {
            throw new RefusedError(media.message);
        }
        address = media.url;
        label = media.name;
    } else {
        try {
            // A relative address is the page's, as a link on it would be.
            address = new URL(what.url ?? "", target.url).href;
        } catch {
            throw new RefusedError(`"${(what.url ?? "").slice(0, 80)}" is not an address. Pass the file's full address, or its ref from a snapshot.`);
        }
    }
    const saved = await saveMediaFromTab(from, target.id, address, what.name ?? (label || stemOfUrl(address)), { pointedAt: what.ref !== undefined });
    announce(target.id, `The agent saved a file from this page to its sandbox`);
    return `Saved ${megabytes(saved.bytes)} (${saved.mimeType}) to ${saved.path}. It is a file in your sandbox now: read it from that path.`;
};

interface Collected {
    readonly data: Uint8Array;
    readonly name: string;
    readonly mimeType: string;
}

// The file for `ticket`, from the sandbox that minted it (the one whose socket the call came over), on this browser's
// own token; or the sandbox's own sentence why not.
const collectFile = async (from: SandboxKey, ticket: string): Promise<Collected> => {
    const sandbox = await store.sandbox(from);
    if (sandbox === undefined) {
        throw new RefusedError(`This browser is not paired with a sandbox any more.`);
    }
    const response = await fetch(webextFileUrl(sandbox.url), {
        method: "POST",
        headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
    }).catch(() => {
        throw new RefusedError(`This browser could not reach the sandbox to collect the file, so nothing was attached.`);
    });
    if (!response.ok) {
        // allow(silent-catch): a body that is not JSON is the unreadable refusal below, with its status
        const refusal = WebExtFileRefusalSchema.safeParse(await response.json().catch(() => undefined));
        throw new RefusedError(refusal.success ? refusal.data.message : `The sandbox did not hand the file over (${response.status}), so nothing was attached.`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > WEBEXT_MEDIA_MAX_BYTES) {
        throw new RefusedError(`That file is larger than the ${WEBEXT_MEDIA_MAX_BYTES / 1_048_576} MB a page takes from the sandbox.`);
    }
    let name = "file";
    try {
        name = decodeURIComponent(response.headers.get(WEBEXT_MEDIA_NAME_HEADER) ?? "file") || "file";
        // allow(silent-catch): a name that does not decode is replaced by "file", which is what the person is shown
    } catch {
        name = "file";
    }
    return { data, name, mimeType: response.headers.get("content-type") ?? "application/octet-stream" };
};

// A sandbox file into a page's file input. The daemon added `ticket` to this call on its way here, having checked the
// file is on the sandbox's artifacts shelf; the file is collected for it, the input found, and then the person is asked
// on the page every time, with the file's name and size, whatever their switches say: a sandbox file reaching a website
// is theirs to allow. Only then does the file cross into the page.
const uploadFile = async (from: SandboxKey, ref: string, ticket: string | undefined, tabId?: number): Promise<string> => {
    if (ticket === undefined) {
        throw new RefusedError(`This browser takes a file only through its sandbox, which adds a ticket to the call on its way here. Call upload_file through your sandbox's mount of this browser.`);
    }
    const target = await targetTab(from, "act", tabId);
    const file = await collectFile(from, ticket);
    const pin = crypto.randomUUID();
    const found = await inject(target.id, findFileInput, [ref, pin, file.name, file.mimeType]);
    if (!found.ok) {
        throw new RefusedError(found.message);
    }
    const { origin, host } = new URL(target.url);
    const what = `give ${host} the file “${file.name}” (${megabytes(file.data.byteLength)}) from its sandbox`;
    if (!(await askPerson(from, target, `Your agent wants to ${what}. Allow it?`, CONFIRM_TIMEOUT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to: ${what}. Do not try another way round it; ask them what they would prefer.`);
    }
    // Asked again now they have answered: the tab may have been paused, narrowed to reading, or moved to another site.
    const now = await targetTab(from, "act", target.id);
    if (new URL(now.url).origin !== origin) {
        throw new RefusedError(`The page moved to another site while the person was being asked, so nothing was attached.`);
    }
    for (let offset = 0; offset < file.data.byteLength; offset += SLICE_BYTES) {
        await inject(target.id, receiveFileSlice, [pin, toBase64(file.data.subarray(offset, offset + SLICE_BYTES))]);
    }
    const put = await inject(target.id, putFile, [pin, file.name, file.mimeType]);
    if (!put.ok) {
        throw new RefusedError(put.message);
    }
    announce(target.id, `The agent attached “${file.name}” from its sandbox`);
    return `Attached “${file.name}” (${megabytes(file.data.byteLength)}) to the file input on ${host}. The page may still need you to send or submit it.\n\n${await snapshot(from, target.id)}`;
};

export const MEDIA_TOOLS: readonly McpTool<SandboxKey>[] = [
    tool({
        name: "save_media",
        description:
            "Save a picture, video, sound or file you see on a page into your sandbox, and answer with the path to read it from. Aim at it by `ref` (an img or video line from a snapshot, or the button or link that shows it) or give its `url`; exactly one of the two. The page's own sign-in is used, so a picture only the person can see comes too. A `url` needs act on the site and brings in only a picture, video, sound, document, archive or a file the site serves as a download; a `ref` needs only read. Up to 50 MB.",
        // Writes a file into the sandbox; nothing on the page changes.
        effect: "write",
        input: object({
            ref: required.optional().describe("The [e…] ref of the picture, video, link or button that shows it."),
            url: required.optional().describe("The file's address instead of a ref: http(s), blob: or data:. A relative one is the page's. Needs act on the site."),
            name: string().max(80).optional().describe("A name for the file in the sandbox, without extension. Defaults to what the page calls it."),
            tab,
        }).refine((args) => (args.ref === undefined) !== (args.url === undefined), {
            error: `Say what to save: a "ref" from a snapshot, or a "url", not both.`,
            path: ["ref"],
        }),
        run: async ({ ref, url, name, tab: id }, from) =>
            textResult(await saveMedia(from, { ref, url, name }, id)),
    }),
    tool({
        name: WEBEXT_UPLOAD_TOOL,
        description:
            "Put a file from your sandbox into a page's file input, as if the person had chosen it: to attach a picture to a chat or a form. `ref` is the file input, or the button that opens the file chooser. The file must be on your sandbox's artifacts shelf (.intentic/records/artifacts/, chat attachments included): copy it there first. The person is asked on the page every time, with the file's name and size. It attaches only: sending is your next step.",
        // A sandbox file reaches a website, and nothing takes it back.
        effect: "destructive",
        input: object({
            ref: required.describe("The file input's [e…] ref, or the button that opens the file chooser."),
            path: required.describe("The file in your sandbox, e.g. /work/.intentic/records/artifacts/chrome/frame.png."),
            tab,
            ticket: string().optional().describe("Leave this out: your sandbox adds it on the way."),
        }),
        run: async ({ ref, ticket, tab: id }, from) => textResult(await uploadFile(from, ref, ticket, id)),
    }),
];
