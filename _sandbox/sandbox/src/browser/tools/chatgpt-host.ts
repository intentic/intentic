import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import type { JsonValue } from "@intentic/base/json";
import { WEBEXT_MEDIA_MAX_BYTES } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import type { PageCall, PageStep, SavedFile } from "@intentic/site-kits";
import { CHATGPT_PAGE, type ChatgptHost, type ChatgptVoice, KitRefusal, type MemoryName } from "@intentic/site-kits/chatgpt";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { statePath, stateRelPath } from "../../state-paths.js";
import { cacheFile } from "../../store/open-document.js";
import { releasable, type ShelfFile, storeMediaIn } from "../../webext/media-shelf.js";
import { evaluated } from "./evaluate-answer.js";

// THE CHATGPT KIT'S SANDBOX HOST (2026-11-14): a sandbox account's own signed-in Chromium, driven through its
// @playwright/mcp backend from the browser router, for the kit's engine in @intentic/site-kits, which decides every step
// and every word the agent reads. What is this browser's own is here: one tab per account (the backend's current one),
// each page step as ONE browser_evaluate in ChatGPT's own world, files as artifacts-shelf paths Playwright puts into the
// file input, pictures fetched in the page and handed back in slices, and a small JSON memory per browser. The router's
// side (which accounts may, the tool list, one call at a time) is chatgpt-kit.ts; what each member means is said once,
// for both hosts, at the top of the kit's host.ts. The person's own Chrome is the other host
// (_devices/webext/src/background/kits/chatgpt/chrome-host.ts).

// The only page there is: the backend's current tab. The engine never sees tab bookkeeping, and here there is none.
const PAGE = 1;

// One tools/call to the account's backend, its browser brought up on the first; a backend that cannot come up throws a
// KitRefusal saying why.
export type BackendCall = (params: { readonly name: string; readonly arguments: Readonly<Record<string, string>> }) => Promise<RpcMessage>;

// The account's one tab, held by one kit call at a time.
export interface TabHold {
    // Throws a KitRefusal while another call holds it.
    readonly take: () => void;
    readonly heldByOther: () => boolean;
    readonly release: () => void;
}

export interface SandboxHostContext {
    // The account the call named, for the words; undefined on a router with one browser and no `account`.
    readonly account: string | undefined;
    // The browser profile it lives in, whose memory this is.
    readonly owner: string;
    // The workspace root: the artifacts shelf files are vetted against and saved on, and the memory's place.
    readonly root: string;
    readonly sandboxName: () => Promise<string>;
    // Why this browser may not run ChatGPT (chatgpt-kit.ts), or undefined.
    readonly refusal: string | undefined;
    readonly send: BackendCall;
    readonly tab: TabHold;
}

// Where the kit's pictures and long answers land: on the artifacts shelf beside `chrome/` (the person's own browser's
// saves), not in `browser/`, whose captures nothing reads once their turn ends.
export const CHATGPT_SAVED_REL = stateRelPath(".intentic/records/artifacts/", "chatgpt");

// How this browser is named to the agent. `account` names the call's own browser; tool descriptions have none, and a
// router with one browser (`sole`) takes no `account` at all.
export const sandboxVoice = (who: { readonly account?: string | undefined; readonly sole: boolean }): ChatgptVoice => {
    const { account, sole } = who;
    const asAccount = `${sole ? "" : "Pass `account`: a sandbox account signed in to chatgpt.com, or the identity whose browser holds one (`mcp__accounts__roster` names them). "}Leave that browser alone while a call runs: the tool drives its tab.`;
    return {
        page: () => (account === undefined ? "the browser's tab" : `the browser's tab (account "${account}")`),
        browser: account === undefined ? "this sandbox browser" : `the sandbox browser of account "${account}"`,
        snapshotTool: "browser_snapshot",
        saveTool: "browser_take_screenshot",
        signedIn: sole ? "this sandbox browser" : "a sandbox account's own signed-in browser (the one `account` names)",
        window: "that browser's tab",
        sendAccess: `${asAccount} Files must be on your sandbox's artifacts shelf; they go to ChatGPT as browser_file_upload sends a file, without asking anyone.`,
        imageAccess: asAccount,
        asking:
            account === undefined
                ? ""
                : `The owner can look at that tab themselves: call \`request_help\` on the \`accounts\` server (\`mcp__accounts__request_help\`) with account "${account}", saying which button ChatGPT shows and what it asks; it returns once they are done.`,
    };
};

// ---- one step, one browser_evaluate -------------------------------------------------------------------------------

const callSource = (call: PageCall): string => `(${call.func.toString()})(...${JSON.stringify(call.args)})`;

// The function browser_evaluate runs for one step, in ChatGPT's own world, where the page's scripts could see what the
// kit leaves on the window: each helper installed, the step called, and the helpers taken away again as soon as the
// step has captured them (a step reads them before its first await), before it waits; then its answer, wrapped, so a
// step's own null is told from a page that answered nothing.
const stepSource = <Result>(step: PageStep<Result>): string =>
    [
        "async () => {",
        "    let pending = null;",
        "    try {",
        ...step.helpers.map((helper) => `        ${callSource(helper)};`),
        `        pending = ${callSource(step.step)};`,
        "    } finally {",
        `        ${callSource(step.cleanup)};`,
        "    }",
        "    return { answer: (await pending) ?? null };",
        "}",
    ].join("\n");

const StepAnswerSchema = z.object({ answer: z.unknown() });

const run = async <Result>(send: BackendCall, step: PageStep<Result>): Promise<Result | undefined> => {
    const said = evaluated(await send({ name: "browser_evaluate", arguments: { function: stepSource(step) } }));
    const answer = "value" in said ? StepAnswerSchema.safeParse(said.value).data?.answer : undefined;
    // SAFETY: the step's own function returned it through JSON, and a step answers its Result or null (PageStep).
    return answer === undefined || answer === null ? undefined : (answer as Result);
};

// Where the tab is: the page's own location, else Playwright's record of it (mid-navigation, evaluate has no page to
// ask); undefined only when neither answers.
const address = async (send: BackendCall): Promise<string | undefined> => {
    const href = evaluated(await send({ name: "browser_evaluate", arguments: { function: "() => location.href" } }));
    const seen = "value" in href ? z.string().safeParse(href.value).data : undefined;
    if (seen !== undefined) {
        return seen;
    }
    const url = evaluated(await send({ name: "browser_run_code_unsafe", arguments: { code: "async (page) => page.url()" } }));
    return "value" in url ? z.string().safeParse(url.value).data : undefined;
};

// ---- files into ChatGPT's file input ------------------------------------------------------------------------------

const AttachedSchema = z.object({ ok: z.boolean(), message: z.string() });

// Runs in Playwright's process through browser_run_code_unsafe, from its source text alone: puts the file at `path` into
// the composer's file input that takes its type (as the extension's pinFileInputStep chooses), which Playwright fills as
// a person's choice would, `change` and all.
const attachInPage = async (page: Page, selector: string, path: string, name: string, type: string): Promise<{ ok: boolean; message: string }> => {
    const inputs = page.locator(selector);
    const index = await inputs.evaluateAll(
        (elements, file) =>
            elements.findIndex((element) => {
                if (!(element instanceof HTMLInputElement) || element.disabled) {
                    return false;
                }
                const lower = file.name.toLowerCase();
                const accept = element.accept
                    .split(",")
                    .map((token) => token.trim().toLowerCase())
                    .filter((token) => token !== "");
                const takes = (token: string): boolean =>
                    token.startsWith(".") ? lower.endsWith(token) : token.endsWith("/*") ? file.type.startsWith(token.slice(0, -1)) : token === file.type;
                return accept.length === 0 || accept.some(takes);
            }),
        { name, type },
    );
    if (index < 0) {
        return { ok: false, message: `ChatGPT's page has no file input that takes ${type} (${name}).` };
    }
    await inputs.nth(index).setInputFiles(path);
    return { ok: true, message: "attached" };
};

const attachSource = (file: ShelfFile): string =>
    `async (page) => (${attachInPage.toString()})(page, ...${JSON.stringify([CHATGPT_PAGE.fileInput, file.path, file.name, file.mimeType])})`;

// Each file vetted as the extension's upload_file vets one (on the shelf, a regular file, under the size cap) and
// readable by the browser. The backend runs as this daemon's own user (workload-class.ts spawnAs sets only its class),
// so what this process may read, the browser may.
const collectFiles = async (root: string, given: readonly string[]): Promise<ShelfFile[]> => {
    const files: ShelfFile[] = [];
    for (const asked of given) {
        const file = await releasable(root, asked);
        if (!file.ok) {
            throw new KitRefusal(`${file.refusal} Nothing was sent.`);
        }
        const readable = await access(file.path, constants.R_OK).then(
            () => true,
            () => false,
        );
        if (!readable) {
            throw new KitRefusal(`The browser cannot read ${asked}: its permissions keep the browser out. Nothing was sent. Make it readable (chmod a+r ${file.path}) and call again.`);
        }
        files.push(file);
    }
    return files;
};

const attachFiles = async (send: BackendCall, files: readonly ShelfFile[]): Promise<void> => {
    for (const file of files) {
        const said = evaluated(await send({ name: "browser_run_code_unsafe", arguments: { code: attachSource(file) } }));
        const put = "value" in said ? AttachedSchema.safeParse(said.value).data : undefined;
        if (put?.ok !== true) {
            const why = put?.message ?? `${file.name} did not reach ChatGPT's file input (${"failure" in said ? said.failure : "the browser said nothing"}).`;
            throw new KitRefusal(`Nothing was sent: ${why} If it says the same again, tell the owner the ChatGPT kit needs fixing.`);
        }
    }
};

// ---- pictures and long answers onto the shelf -----------------------------------------------------------------------

// One slice of a picture per evaluate: base64 of it rides in one answer.
const SLICE_BYTES = 2 * 1024 * 1024;

const SliceSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), total: z.number(), type: z.string(), base64: z.string() }),
    z.object({ ok: z.literal(false), message: z.string() }),
]);

// Runs in ChatGPT's page through browser_evaluate, from its source text alone: the picture at `src` fetched with the
// page's own sign-in, and one slice of it as base64. Each slice fetches again rather than leaving the bytes on the
// window between calls; the browser's cache answers the second.
const pictureSlice = async (src: string, offset: number, size: number): Promise<z.infer<typeof SliceSchema>> => {
    try {
        const response = await fetch(src, { credentials: "include", cache: "force-cache" });
        if (!response.ok) {
            return { ok: false, message: `the picture's address answered ${response.status}` };
        }
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
        let binary = "";
        for (let at = 0; at < bytes.length; at += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        }
        return { ok: true, total: blob.size, type: blob.type, base64: btoa(binary) };
    } catch (error) {
        // allow(primitive-tiers): this runs in the page from its own source text, where errorMessage cannot be imported.
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
};

const sliceSource = (src: string, offset: number): string => `() => (${pictureSlice.toString()})(...${JSON.stringify([src, offset, SLICE_BYTES])})`;

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

// What the bytes are, by their first ones; a web page (an expired link, a sign-in) is not a picture.
const pictureType = (bytes: Uint8Array, claimed: string): string => {
    const brand = ascii(bytes, 4, 8) === "ftyp" ? ascii(bytes, 8, 12) : undefined;
    const sniffed: readonly (readonly [boolean, string])[] = [
        [startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]), "image/png"],
        [startsWith(bytes, [0xff, 0xd8, 0xff]), "image/jpeg"],
        [ascii(bytes, 0, 4) === "GIF8", "image/gif"],
        [ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP", "image/webp"],
        [brand === "avif" || brand === "avis", "image/avif"],
    ];
    const known = sniffed.find(([matches]) => matches)?.[1];
    if (known !== undefined) {
        return known;
    }
    if (/^\s*</u.test(ascii(bytes, 0, 64)) || !claimed.startsWith("image/")) {
        throw new Error(`the picture's address answered ${claimed === "" ? "something" : claimed} that is not a picture (an expired link, or a sign-in page)`);
    }
    return claimed;
};

const saveImage = async (context: SandboxHostContext, src: string, stem: string): Promise<SavedFile> => {
    const parts: Buffer[] = [];
    let offset = 0;
    let total = 1;
    let claimed = "";
    while (offset < total) {
        const said = evaluated(await context.send({ name: "browser_evaluate", arguments: { function: sliceSource(src, offset) } }));
        const slice = "value" in said ? SliceSchema.safeParse(said.value).data : undefined;
        if (slice === undefined || !slice.ok) {
            throw new Error(slice?.message ?? `the page did not hand the picture over (${"failure" in said ? said.failure : "it said nothing"})`);
        }
        if (slice.total > WEBEXT_MEDIA_MAX_BYTES) {
            throw new Error(`the picture is ${Math.round(slice.total / 1_048_576)} MB, past the ${WEBEXT_MEDIA_MAX_BYTES / 1_048_576} MB one save carries`);
        }
        ({ total, type: claimed } = slice);
        const part = Buffer.from(slice.base64, "base64");
        parts.push(part);
        offset += part.byteLength === 0 ? total : part.byteLength;
    }
    const bytes = Buffer.concat(parts);
    if (bytes.byteLength === 0) {
        throw new Error("the picture's address answered an empty file");
    }
    return await storeMediaIn(join(context.root, CHATGPT_SAVED_REL), bytes, pictureType(bytes, claimed), stem);
};

// ---- what the kit keeps between calls -----------------------------------------------------------------------------

// A cache, not a document (store/open-document.ts cacheFile): losing it costs one look in ChatGPT's sidebar for the
// project by name, and chats are opened again by their address. Per browser, beside its profile and passkeys.
const MemorySchema = z.record(z.string(), z.json());
type Memory = Readonly<Record<string, JsonValue>>;

const memoryOf = (root: string, owner: string) => {
    const path = statePath(root, ".intentic/local/browser/", `${owner}.chatgpt.json`);
    const file = cacheFile<Memory>(path, { parse: (raw) => MemorySchema.safeParse(raw).data, fallback: () => ({}) });
    return {
        recall: async (name: MemoryName): Promise<JsonValue | undefined> => (await file.read())[name],
        keep: async (name: MemoryName, value: JsonValue): Promise<void> => {
            await mkdir(dirname(path), { recursive: true });
            await file.update((all) => ({ ...all, [name]: value }));
        },
    };
};

// The kit's host for one call in one account's browser.
export const sandboxChatgptHost = (context: SandboxHostContext): ChatgptHost<ShelfFile> => {
    const { send, tab } = context;
    const memory = memoryOf(context.root, context.owner);
    const navigate = async (url: string): Promise<void> => {
        await send({ name: "browser_navigate", arguments: { url } });
    };
    return {
        voice: sandboxVoice({ account: context.account, sole: context.account === undefined }),
        gate: async () => {
            if (context.refusal !== undefined) {
                throw new KitRefusal(context.refusal);
            }
        },
        permit: async () => undefined,
        open: async (url) => {
            tab.take();
            await navigate(url);
            return { page: PAGE, afterword: "" };
        },
        take: async () => tab.take(),
        busy: () => tab.heldByOther(),
        done: async () => tab.release(),
        forget: async () => undefined,
        address: async () => await address(send),
        navigate: async (_page, url) => await navigate(url),
        run: async (_page, step) => await run(send, step),
        announce: () => undefined,
        // The agent's own browser: its browser_file_upload asks nobody either.
        confirmSend: async () => undefined,
        collectFiles: async (given) => await collectFiles(context.root, given),
        allowFiles: async () => undefined,
        attachFiles: async (_page, files) => await attachFiles(send, files),
        saveImage: async (_page, src, stem) => await saveImage(context, src, stem),
        saveText: async (text, stem) => await storeMediaIn(join(context.root, CHATGPT_SAVED_REL), Buffer.from(text, "utf8"), "text/markdown", stem),
        sandboxName: context.sandboxName,
        recall: memory.recall,
        keep: memory.keep,
    };
};
