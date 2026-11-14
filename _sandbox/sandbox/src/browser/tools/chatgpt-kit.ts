import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import {
    CHATGPT_IMAGE_FIELDS,
    CHATGPT_READ_FIELDS,
    CHATGPT_SEND_FIELDS,
    CHATGPT_SITE,
    CHATGPT_TOOL_EFFECTS,
    CHATGPT_TOOL_NAMES,
    type ChatgptHost,
    type ChatTiming,
    chatgptImage,
    chatgptRead,
    chatgptSend,
    chatgptToolDescriptions,
    KitRefusal,
} from "@intentic/site-kits/chatgpt";
import { opt } from "../../opt.js";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { WEBEXT_CLIENT_TIMEOUT_MS } from "../../peers/webext-call-deadline.js";
import type { ShelfFile } from "../../webext/media-shelf.js";
import { fitToClient, withNote } from "../../webext/webext-client-ceiling.js";
import type { McpToolSchema, RouterManifest } from "./browser-router.js";
import { ANONYMOUS_BROWSER_SERVER } from "./browser-servers.js";
import { type BackendCall, sandboxChatgptHost, sandboxVoice, type TabHold } from "./chatgpt-host.js";

// THE CHATGPT KIT AS THE SIGNED-IN BROWSER ROUTER'S OWN TOOLS (2026-11-14): chatgpt_send, chatgpt_read and chatgpt_image,
// listed beside the backend's Playwright tools when one of the turn's accounts is signed in on chatgpt.com, each taking
// the router's `account` like every other tool. A call is the kit's engine (@intentic/site-kits) on chatgpt-host.ts in
// that account's browser, so the agent reads the same words as through the person's own Chrome. Like browser_webmcp_call
// (webmcp-call.ts), it is answered here, through the backend's own tools. A call whose browser holds no ChatGPT account
// is refused before that browser is started.

// What the router hands the kit; absent, a router no workspace stands behind lists no kit tools.
export interface KitDeps {
    // The workspace root: the artifacts shelf and each browser's memory.
    readonly root: string;
    // What the sandbox's own ChatGPT project is named after ("Intentic · <name>").
    readonly sandboxName: () => Promise<string>;
    // The kit's waits; absent is the kit's own (CHAT_TIMING), tests shorten them.
    readonly timing?: ChatTiming;
}

// How long the agent's client is told to wait on one call of the router that lists the kit: chatgpt_send and
// chatgpt_image wait up to nine minutes in one call, as through the person's own browser, so the same ceiling.
export const CHATGPT_CALL_TIMEOUT_MS = WEBEXT_CLIENT_TIMEOUT_MS;

const coversChatgpt = (hosts: readonly string[]): boolean => hosts.some((known) => CHATGPT_SITE.host === known || CHATGPT_SITE.host.endsWith(`.${known}`));

type Reach = Pick<RouterManifest, "accounts" | "accountSites" | "soleOwner">;

// The accounts this turn holds that are signed in on chatgpt.com (account-hosts.ts accountSitesOf).
const chatgptAccounts = (manifest: Reach): string[] =>
    Object.entries(manifest.accountSites ?? {})
        .filter(([id, hosts]) => manifest.accounts[id] !== undefined && coversChatgpt(hosts))
        .map(([id]) => id);

// Whether this router's browsers can run ChatGPT: one of its accounts is on chatgpt.com, or it is a router of one
// browser that is not the credential-free one (`web` is signed into nothing, and ChatGPT there would be nobody's).
export const chatgptReachable = (manifest: Reach): boolean =>
    manifest.soleOwner === undefined ? chatgptAccounts(manifest).length > 0 : manifest.soleOwner !== ANONYMOUS_BROWSER_SERVER;

const NO_ACCOUNT =
    "No account this turn holds is signed in on chatgpt.com, so no sandbox browser here can run ChatGPT. Nothing was sent. Ask the owner to connect a ChatGPT account to this sandbox (a browser account for chatgpt.com, or one opened through an identity with `mcp__accounts__open_account`) and sign it in: in that account's browser here, or by handing over the session from their own Chrome with that browser's `connect_site` on chatgpt.com.";
const CREDENTIAL_FREE =
    "This browser is signed into nothing, so ChatGPT here would be nobody's. Nothing was sent. Use chatgpt_send on the `browser` server with a ChatGPT account's `account`.";

// Why the named account's browser may not run ChatGPT, or undefined: a browser holding an account on chatgpt.com may,
// whichever of its ids the call names (an identity's own, or the account born of it).
const chatgptRefusal = (manifest: Reach, account: string | undefined, owner: string): string | undefined => {
    if (manifest.soleOwner !== undefined) {
        return chatgptReachable(manifest) ? undefined : CREDENTIAL_FREE;
    }
    const held = chatgptAccounts(manifest);
    if (held.some((id) => manifest.accounts[id] === owner)) {
        return undefined;
    }
    if (held.length === 0) {
        return NO_ACCOUNT;
    }
    const named = held.map((id) => `"${id}"`).join(" or ");
    return `Account "${account ?? owner}"'s browser is not signed in to ChatGPT: no account on chatgpt.com this turn holds lives in it. Nothing was sent. Pass \`account\` ${named}: ${held.length === 1 ? "the account" : "the accounts"} on chatgpt.com this turn holds.`;
};

interface KitContext {
    readonly host: ChatgptHost<ShelfFile>;
    readonly timing: ChatTiming | undefined;
}

// The three tools, worded for this router: through its `account`, or its one browser.
const kitTools = (sole: boolean): McpTool<KitContext>[] => {
    const described = chatgptToolDescriptions(sandboxVoice({ sole }));
    return [
        tool({
            name: CHATGPT_TOOL_NAMES.send,
            description: described.send,
            effect: CHATGPT_TOOL_EFFECTS.send,
            input: z.object(CHATGPT_SEND_FIELDS),
            run: async ({ prompt, chat, mode, files, wait, name, personalized, temporary }, { host, timing }) =>
                textResult(await chatgptSend(host, { prompt, chat, mode, files, waitSeconds: wait, name, personalized, temporary }, timing)),
        }),
        tool({
            name: CHATGPT_TOOL_NAMES.read,
            description: described.read,
            effect: CHATGPT_TOOL_EFFECTS.read,
            input: z.object(CHATGPT_READ_FIELDS),
            run: async ({ chat, wait, name }, { host, timing }) => textResult(await chatgptRead(host, { chat, waitSeconds: wait, name }, timing)),
        }),
        tool({
            name: CHATGPT_TOOL_NAMES.image,
            description: described.image,
            effect: CHATGPT_TOOL_EFFECTS.image,
            input: z.object(CHATGPT_IMAGE_FIELDS),
            run: async ({ prompt, chat, name, personalized, temporary }, { host, timing }) =>
                textResult(await chatgptImage(host, { prompt, chat, name, personalized, temporary }, timing)),
        }),
    ];
};

const ListedInputSchema = z.looseObject({
    type: z.string().exactOptional(),
    properties: z.record(z.string(), z.unknown()).exactOptional(),
    required: z.array(z.string()).exactOptional(),
});

const listedOf = (each: McpTool<KitContext>): McpToolSchema => ({
    name: each.name,
    description: each.description,
    inputSchema: ListedInputSchema.parse(each.inputSchema),
    annotations: each.annotations,
});

// The router's line to one owner's backend once it is up: one tools/call sent on it (browser-router.ts forward), or why
// it would not come up.
export type BackendLine =
    | { readonly send: (params: NonNullable<RpcMessage["params"]>, signal?: AbortSignal) => Promise<RpcMessage> }
    | { readonly refusal: string };

export interface KitCall {
    readonly account: string | undefined;
    readonly owner: string;
    // The call's arguments, less `account`.
    readonly args: NonNullable<RpcMessage["params"]>;
    readonly signal?: AbortSignal | undefined;
    readonly clientCeilingMs?: number | undefined;
    // Brings the owner's backend up; asked only once the kit sends its first call, so a refused call costs none.
    readonly line: () => Promise<BackendLine>;
}

// The backend, brought up on the first call the engine sends, and given up on once the agent's client hung up.
const lazyBackend = (call: KitCall): BackendCall => {
    let brought: Promise<BackendLine> | undefined;
    return async (params) => {
        if (call.signal?.aborted === true) {
            throw new Error("the call was cancelled");
        }
        brought ??= call.line();
        const line = await brought;
        if ("refusal" in line) {
            throw new KitRefusal(`${line.refusal.replace(/\.$/u, "")}. Nothing was sent.`);
        }
        return await line.send(params);
    };
};

// One kit call at a time per browser: they share its one tab.
const holdOf = (holders: Map<string, symbol>, owner: string, words: string): TabHold => {
    const token = Symbol(owner);
    const heldByOther = (): boolean => {
        const holder = holders.get(owner);
        return holder !== undefined && holder !== token;
    };
    return {
        take: () => {
            if (heldByOther()) {
                throw new KitRefusal(`Another ChatGPT call is still working in ${words}. Wait for its answer, then call again. Nothing was sent.`);
            }
            holders.set(owner, token);
        },
        heldByOther,
        release: () => {
            if (holders.get(owner) === token) {
                holders.delete(owner);
            }
        },
    };
};

export interface ChatgptKit {
    // The tools as tools/list shows them: none unless this router's browsers can reach ChatGPT.
    readonly listed: () => McpToolSchema[];
    // Whether a tools/call is the kit's, answered here and not by a backend.
    readonly handles: (message: RpcMessage) => boolean;
    readonly call: (message: RpcMessage, call: KitCall) => Promise<RpcMessage>;
}

export const createChatgptKit = (manifest: Reach, deps: KitDeps | undefined): ChatgptKit => {
    const tools = kitTools(manifest.soleOwner !== undefined);
    const holders = new Map<string, symbol>();
    const answer = (message: RpcMessage, result: ReturnType<typeof textResult>): RpcMessage => ({ jsonrpc: "2.0", id: message.id ?? null, result });
    const ownOf = (message: RpcMessage): McpTool<KitContext> | undefined => (deps === undefined ? undefined : tools.find((each) => each.name === message.params?.["name"]));
    return {
        listed: () => (deps !== undefined && chatgptReachable(manifest) ? tools.map(listedOf) : []),
        handles: (message) => ownOf(message) !== undefined,
        call: async (message, call) => {
            const own = ownOf(message);
            if (deps === undefined || own === undefined) {
                return answer(message, textResult(`${String(message.params?.["name"])} is not a tool of this browser`, true));
            }
            // A client that stops waiting sooner than a call can take gets a call cut to fit, or chatgpt_image refused.
            const asked: RpcMessage = { ...message, params: { ...message.params, arguments: call.args } };
            const fitted = fitToClient(asked, opt("clientCeilingMs", call.clientCeilingMs));
            if (fitted.kind === "refused") {
                return fitted.answer;
            }
            const sent = fitted.kind === "shortened" ? fitted.message : asked;
            const words = call.account === undefined ? "this browser" : `account "${call.account}"'s browser`;
            const tab = holdOf(holders, call.owner, words);
            const host = sandboxChatgptHost({
                account: call.account,
                owner: call.owner,
                root: deps.root,
                sandboxName: deps.sandboxName,
                refusal: chatgptRefusal(manifest, call.account, call.owner),
                send: lazyBackend(call),
                tab,
            });
            try {
                const result = answer(message, await own.call(sent.params?.["arguments"], { host, timing: deps.timing }));
                return fitted.kind === "shortened" ? (withNote(result, fitted.note) ?? result) : result;
            } catch (error) {
                return answer(message, textResult(error instanceof KitRefusal ? error.message : `The ChatGPT kit failed: ${errorMessage(error)}`, true));
            } finally {
                tab.release();
            }
        },
    };
};
