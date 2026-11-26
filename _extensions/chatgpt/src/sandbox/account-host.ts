import { z } from "zod";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { JsonValue } from "@intentic/base/json";
import type { ExtensionServerApi, ServerDocument, ToolArguments, ToolGrantAccount, ToolResult, TurnStanding } from "@intentic/extension-api";
import { KitRefusal, type PageCall, type PageStep, type SavedFile } from "../kit/index.js";
import type { ChatgptHost, ChatgptVoice, MemoryName } from "../kit/chatgpt/index.js";
import { attachThroughChooser } from "./attach.js";
import { evaluated } from "./page.js";
import { collectShelfFiles, MEDIA_MAX_BYTES, type ShelfFile, storeOnShelf } from "./shelf.js";

// THE KIT'S SANDBOX HOST (2026-11-14 in the daemon's browser tools, moved here 2026-11-26): a sandbox account's own
// signed-in Chromium, driven through `api.browser.call`, the router and guards the agent's `browser` tools use, held to
// the page's own tools and the account's own sites. What is this browser's own is here: one tab per account (the
// router's current one), each page step as ONE browser_evaluate in ChatGPT's own world, files put in the way an agent
// puts one (a click that opens the file chooser, then browser_file_upload), pictures fetched in the page and handed back
// in parts, and a small JSON memory per account in this extension's own state. What each member means is said once,
// for both hosts, at the top of the kit's chatgpt/host.ts; the person's own Chrome is the other host
// (_devices/webext/src/background/kits/chatgpt/chrome-host.ts).

// The only page there is: the router's current tab. The engine never sees tab bookkeeping, and here there is none.
const PAGE = 1;

// The account's one tab, held by one kit call at a time.
export interface TabHold {
    // Throws a KitRefusal while another call holds it.
    readonly take: () => void;
    readonly heldByOther: () => boolean;
    readonly release: () => void;
}

// One kit call at a time per account: they share its one tab.
export const tabHold = (holders: Map<string, symbol>, account: string): TabHold => {
    const token = Symbol(account);
    const heldByOther = (): boolean => {
        const holder = holders.get(account);
        return holder !== undefined && holder !== token;
    };
    return {
        take: () => {
            if (heldByOther()) {
                throw new KitRefusal(`Another ChatGPT call is still working in account "${account}"'s browser. Wait for its answer, then call again. Nothing was sent.`);
            }
            holders.set(account, token);
        },
        heldByOther,
        release: () => {
            if (holders.get(account) === token) {
                holders.delete(account);
            }
        },
    };
};

// How a sandbox account's browser is named to the agent. `account` names the call's own browser; the tool descriptions
// have none.
export const sandboxVoice = (account: string | undefined): ChatgptVoice => {
    const asAccount =
        "Pass `account`: a sandbox account signed in to chatgpt.com (`mcp__accounts__roster` names them); left out, the one such account this turn holds. Leave that browser alone while a call runs: the tool drives its tab.";
    return {
        page: () => (account === undefined ? "the browser's tab" : `the browser's tab (account "${account}")`),
        browser: account === undefined ? "the sandbox browser" : `the sandbox browser of account "${account}"`,
        snapshotTool: "browser_snapshot",
        saveTool: "browser_take_screenshot",
        signedIn: "a sandbox account's own signed-in browser (the one `account` names), or the person's own browser (`browser`)",
        window: "that browser's tab",
        sendAccess: `${asAccount} Files must be on your sandbox's artifacts shelf; in a sandbox browser they go to ChatGPT as browser_file_upload sends a file, without asking anyone, and in the person's own browser the person is asked first.`,
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

// ---- pictures onto the shelf --------------------------------------------------------------------------------------

// One part of a picture per evaluate: base64 of it rides in one answer.
const PART_BYTES = 2 * 1024 * 1024;

const PartSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), total: z.number(), type: z.string(), base64: z.string() }),
    z.object({ ok: z.literal(false), message: z.string() }),
]);

// Runs in ChatGPT's page through browser_evaluate, from its source text alone: the picture at `src` fetched with the
// page's own sign-in, and one part of it as base64. Each part fetches again rather than leaving the bytes on the
// window between calls; the browser's cache answers the second.
const picturePart = async (src: string, offset: number, size: number): Promise<z.infer<typeof PartSchema>> => {
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

const partSource = (src: string, offset: number): string => `() => (${picturePart.toString()})(...${JSON.stringify([src, offset, PART_BYTES])})`;

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

// ---- what the kit keeps between calls -----------------------------------------------------------------------------

// A cache, not a record: losing it costs one look in ChatGPT's sidebar for the project by name, and chats are opened
// again by their address. One file per account, in this extension's own state.
const MemorySchema = z.record(z.string(), z.json());
type Memory = Readonly<Record<string, JsonValue>>;

export const memoryOf = (api: Pick<ExtensionServerApi, "document">, account: string): ServerDocument<Memory> =>
    api.document<Memory>(`memory/${encodeURIComponent(account)}.json`, { parse: (raw) => MemorySchema.safeParse(raw).data, fallback: () => ({}) });

// ---- the host -------------------------------------------------------------------------------------------------------

export interface SandboxHostContext {
    readonly api: Pick<ExtensionServerApi, "browser" | "document" | "workspaceRoot" | "log">;
    // The tool call whose turn holds the account: its grants and ticket.
    readonly standing: TurnStanding;
    readonly account: ToolGrantAccount;
    readonly sandboxName: () => Promise<string>;
    readonly tab: TabHold;
    // How long a page step waits for what it looks for (the kit's ChatTiming.stepMs).
    readonly stepMs: number;
}

// How many times an address is asked before the page counts as one this browser may not read: a page mid-navigation
// has nothing to evaluate in for a moment.
const ADDRESS_TRIES = 3;
const ADDRESS_PAUSE_MS = 300;

/** The kit's host for one call in one sandbox account's browser. */
export const sandboxChatgptHost = (context: SandboxHostContext): ChatgptHost<ShelfFile> => {
    const { api, standing, account, tab } = context;
    const memory = memoryOf(api, account.id);
    const call = async (tool: string, args: ToolArguments): Promise<ToolResult> => await api.browser.call(standing, { account: account.id, tool, args });
    const navigate = async (url: string): Promise<void> => {
        const answer = await call("browser_navigate", { url });
        if (answer.isError === true) {
            throw new Error(`the browser did not go to ${url}: ${evaluatedFailure(answer)}`);
        }
    };
    // One step: undefined when the page did not answer (replaced mid-call, it threw, or the sandbox refused the call,
    // since the page is off the account's sites); never a throw, as the engine expects of a host.
    const run = async <Result>(step: PageStep<Result>): Promise<Result | undefined> => {
        try {
            const said = evaluated(await call("browser_evaluate", { function: stepSource(step) }));
            const answer = "value" in said ? StepAnswerSchema.safeParse(said.value).data?.answer : undefined;
            // SAFETY: the step's own function returned it through JSON, and a step answers its Result or null (PageStep).
            return answer === undefined || answer === null ? undefined : (answer as Result);
        } catch (error) {
            api.log(`chatgpt: a page step in account "${account.id}"'s browser did not run: ${errorMessage(error)}`);
            return undefined;
        }
    };
    // Where the tab is; "" when the browser will not say (a page off the account's sites, which the sandbox does not let
    // this extension read, or one still loading), never undefined: the account's one tab is never closed under a call.
    const address = async (): Promise<string> => {
        for (let tries = 1; tries <= ADDRESS_TRIES; tries += 1) {
            // allow(silent-catch): a refused or unanswered read is asked again, then reads as an address it may not see.
            const said = await call("browser_evaluate", { function: "() => location.href" }).then(evaluated, () => undefined);
            const href = said !== undefined && "value" in said ? z.string().safeParse(said.value).data : undefined;
            if (href !== undefined) {
                return href;
            }
            await sleep(ADDRESS_PAUSE_MS);
        }
        return "";
    };
    // One part of the picture at `src` from `offset`, or why the page would not hand it over.
    const part = async (src: string, offset: number): Promise<{ readonly total: number; readonly type: string; readonly bytes: Buffer }> => {
        const said = evaluated(await call("browser_evaluate", { function: partSource(src, offset) }));
        const read = "value" in said ? PartSchema.safeParse(said.value).data : undefined;
        if (read === undefined || !read.ok) {
            throw new Error(read?.message ?? `the page did not hand the picture over (${"failure" in said ? said.failure : "it said nothing"})`);
        }
        if (read.total > MEDIA_MAX_BYTES) {
            throw new Error(`the picture is ${Math.round(read.total / 1_048_576)} MB, past the ${MEDIA_MAX_BYTES / 1_048_576} MB one save carries`);
        }
        return { total: read.total, type: read.type, bytes: Buffer.from(read.base64, "base64") };
    };
    const saveImage = async (src: string, stem: string): Promise<SavedFile> => {
        const parts: Buffer[] = [];
        let offset = 0;
        let total = 1;
        let claimed = "";
        while (offset < total) {
            const read = await part(src, offset);
            ({ total, type: claimed } = read);
            parts.push(read.bytes);
            offset += read.bytes.byteLength === 0 ? total : read.bytes.byteLength;
        }
        const bytes = Buffer.concat(parts);
        if (bytes.byteLength === 0) {
            throw new Error("the picture's address answered an empty file");
        }
        return await storeOnShelf(api.workspaceRoot, bytes, pictureType(bytes, claimed), stem);
    };
    return {
        voice: sandboxVoice(account.id),
        // Which account may run ChatGPT was settled before this host was made (where.ts).
        gate: async () => undefined,
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
        address: async () => await address(),
        navigate: async (_page, url) => await navigate(url),
        run: async (_page, step) => await run(step),
        announce: () => undefined,
        // The agent's own browser: its browser_file_upload asks nobody either.
        confirmSend: async () => undefined,
        collectFiles: async (given) => await collectShelfFiles(api.workspaceRoot, given),
        allowFiles: async () => undefined,
        attachFiles: async (_page, files) => await attachThroughChooser({ call, run, stepMs: context.stepMs }, files),
        saveImage: async (_page, src, stem) => await saveImage(src, stem),
        saveText: async (text, stem) => await storeOnShelf(api.workspaceRoot, Buffer.from(text, "utf8"), "text/markdown", stem),
        sandboxName: context.sandboxName,
        recall: async (name: MemoryName) => (await memory.read())[name],
        keep: async (name: MemoryName, value: JsonValue) => {
            await memory.update((all) => ({ ...all, [name]: value }));
        },
    };
};

const evaluatedFailure = (answer: ToolResult): string => {
    const said = evaluated(answer);
    return "failure" in said ? said.failure : "it said nothing";
};
