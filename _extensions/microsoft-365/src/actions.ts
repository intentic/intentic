import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { type Account, assertWrite, DEFAULT_AUTHORITY } from "./accounts.js";
import type { Graph, Json } from "./graph.js";

// Everything this CLI does that reaches past the mailbox owner: sending mail, changing a calendar others are invited
// to, putting a file where colleagues read it. Each is an action key the owner's action rules (settings.json) decide,
// and each HOLDS when no rule names it: the exact request is frozen into the approvals queue, and only that request,
// once the owner has set it running, is ever sent, once.

export type ActionKey = "microsoft365.mail.send" | "microsoft365.calendar.write" | "microsoft365.files.upload";

export interface Action {
    readonly key: ActionKey;
    // Which card, and the sign-in it was proposed under: an approval never runs on another connection.
    readonly account: string;
    readonly tenantId: string;
    readonly clientId: string;
    readonly authority: string;
    readonly path: string;
    readonly method: "POST" | "PATCH" | "PUT";
    readonly body: Json;
    // A file upload: `body` is its bytes, base64.
    readonly binary?: boolean;
    // What the owner reads on the approval card, written when the action is proposed.
    readonly summary: string;
    readonly details: string;
}

type Rule = "allow" | "hold" | "deny";

// The exact key, else the provider's wildcard, else hold: the same order the daemon's own gate reads (preset.ts).
export const actionRule = (rules: Readonly<Record<string, string>>, key: ActionKey): Rule => {
    const value = rules[key] ?? rules["microsoft365.*"];
    return value === "allow" || value === "deny" ? value : "hold";
};

const digest = (action: Action): string => createHash("sha256").update(JSON.stringify(action)).digest("hex");
const approvalsDir = (root: string): string => join(root, STATE_GROUP_DIR.config, "approvals");
const APPROVAL_ID = /^m365-[a-f0-9-]+$/;

const readRules = async (root: string): Promise<Readonly<Record<string, string>>> => {
    try {
        // SAFETY: only `actionRules` is read, and actionRule treats any value it does not know as hold.
        const settings = JSON.parse(await readFile(join(root, STATE_GROUP_DIR.config, "settings.json"), "utf8")) as {
            actionRules?: Record<string, string>;
        };
        return settings.actionRules ?? {};
    } catch (error) {
        // SAFETY: a failed read from node:fs is a system error carrying `code`; anything else is rethrown unread.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }
        throw error;
    }
};

const sameConnection = (action: Action, account: Account): boolean =>
    action.account === account.id &&
    action.tenantId === account.tenantId &&
    action.clientId === account.clientId &&
    action.authority === (account.authority || DEFAULT_AUTHORITY);

// The approvals queue item: what the owner reads, and what the fresh turn that runs it is told to do.
const propose = async (root: string, action: Action): Promise<string> => {
    const id = `m365-${randomUUID()}`;
    const media = join(approvalsDir(root), "media");
    await mkdir(media, { recursive: true, mode: 0o700 });
    await writeFile(join(media, `${id}.json`), JSON.stringify(action, null, 2), { flag: "wx", mode: 0o600 });
    const item = {
        kind: "action",
        status: "proposed",
        createdAt: Date.now(),
        summary: action.summary.length > 200 ? `${action.summary.slice(0, 197)}…` : action.summary,
        details: action.details,
        instructions: `Run \`m365 --account ${action.account} action run ${id}\`. It sends only the request frozen in ${join(media, `${id}.json`)} (SHA-256 ${digest(action)}), once. Report what Microsoft answered; if the outcome is uncertain, look in Outlook before proposing it again, never retry it blind.`,
    };
    await writeFile(join(approvalsDir(root), `${id}.json`), JSON.stringify(item, null, 2), { flag: "wx", mode: 0o600 });
    return id;
};

// Refuses unless the owner set this exact request running; then claims the one attempt it allows, even against a
// second CLI racing for it. A send whose answer was lost is never repeated by itself: it may already have gone.
const claim = async (root: string, action: Action, approvalId: string): Promise<void> => {
    if (!APPROVAL_ID.test(approvalId)) {
        throw new Error("That is not a Microsoft 365 approval id");
    }
    // SAFETY: status and instructions are the only fields read; both are checked against this exact request below.
    const item = JSON.parse(await readFile(join(approvalsDir(root), `${approvalId}.json`), "utf8")) as { status?: string; instructions?: string };
    if (item.status !== "running" || item.instructions?.includes(digest(action)) !== true) {
        throw new Error("The owner has not set this exact Microsoft 365 action running");
    }
    await writeFile(join(approvalsDir(root), "media", `${approvalId}.attempted`), "attempted", { flag: "wx", mode: 0o600 });
};

export type ActionOutcome = { readonly held: true; readonly approvalId: string } | { readonly held: false; readonly result: Json | undefined };

export const executeAction = async (root: string, graph: Graph, action: Action, approvalId?: string): Promise<ActionOutcome> => {
    assertWrite(graph.account);
    const rule = actionRule(await readRules(root), action.key);
    if (rule === "deny") {
        throw new Error(`${action.key} is denied by this sandbox's action rules`);
    }
    if (!sameConnection(action, graph.account)) {
        throw new Error("That approval belongs to a different Microsoft 365 connection");
    }
    if (approvalId !== undefined) {
        await claim(root, action, approvalId);
    } else if (rule === "hold") {
        return { held: true, approvalId: await propose(root, action) };
    }
    const request =
        action.binary === true
            ? { method: action.method, bytes: Buffer.from(String(action.body), "base64") }
            : { method: action.method, body: action.body };
    return { held: false, result: await graph.call<Json | undefined>(action.path, request) };
};

export const loadAction = async (root: string, id: string): Promise<Action> => {
    if (!APPROVAL_ID.test(id)) {
        throw new Error("That is not a Microsoft 365 approval id");
    }
    // SAFETY: written 0600 by `propose` alone; `claim` then holds it to the digest the owner's approval names.
    return JSON.parse(await readFile(join(approvalsDir(root), "media", `${id}.json`), "utf8")) as Action;
};

export interface ActionDraft {
    readonly key: ActionKey;
    readonly path: string;
    readonly method: Action["method"];
    readonly body: Json;
    readonly binary?: boolean;
    readonly summary: string;
    readonly details: string;
}

export const actionFor = (account: Account, draft: ActionDraft): Action => ({
    ...draft,
    account: account.id,
    tenantId: account.tenantId,
    clientId: account.clientId,
    authority: account.authority || DEFAULT_AUTHORITY,
});
