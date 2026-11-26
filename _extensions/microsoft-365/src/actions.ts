import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type Account, assertWrite, DEFAULT_AUTHORITY } from "./accounts.js";
import { SignInError } from "./auth.js";
import { type Graph, GraphError, type Json, type Request } from "./graph.js";

// Everything this connection does that reaches past the mailbox owner: sending mail, changing a calendar others are
// invited to, putting a file where colleagues read it. Each is an outward action the card declares, and the owner's
// action rules decide it in the daemon, never here (the daemon's outward-action door): this asks, then carries out what
// is allowed, or freezes the exact request for the approvals queue on a hold. A held request is carried out by
// `perform`, which the daemon reaches only after a person's yes was matched against it and spent, and only if what is
// held still hashes to what that yes approved.
// (2026-11-26) Until then `m365` read `actionRules` and the approval's status from workspace files the agent writes, while
// the card's refresh token sat in the agent's environment: a gate the agent could step around.

export type ActionKey = "microsoft365.mail.send" | "microsoft365.calendar.write" | "microsoft365.files.upload";

// The card's kind, which every key starts with; the daemon is asked by the part after it (`mail.send`).
const KIND = "microsoft365.";

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
    // Who or where it goes to, for its Activity row.
    readonly channel?: string;
}

export interface ActionDraft {
    readonly key: ActionKey;
    readonly path: string;
    readonly method: Action["method"];
    readonly body: Json;
    readonly binary?: boolean;
    readonly summary: string;
    readonly details: string;
    readonly channel?: string;
}

export const actionFor = (account: Account, draft: ActionDraft): Action => ({
    ...draft,
    account: account.id,
    tenantId: account.tenantId,
    clientId: account.clientId,
    authority: account.authority || DEFAULT_AUTHORITY,
});

export type ActionOutcome = { readonly held: true; readonly approvalId: string } | { readonly held: false; readonly result: Json | undefined };

// What the daemon's outward-action door is asked and answers (capabilities.outwardAction and its outcome), as the backend's
// typed client calls it. A seam, so the rules can be stood in for.
export interface OutwardCall {
    id: string;
    action: string;
    conversationId?: string;
    endpoint?: string;
    channel?: string;
    content?: string;
}

export type Verdict =
    | { readonly verdict: "allow" }
    | { readonly verdict: "deny"; readonly reason: string }
    | { readonly verdict: "hold"; readonly reason: string; readonly approvalId?: string | undefined };

export interface Outward {
    readonly ask: (call: OutwardCall & { readonly hold?: { readonly summary: string; readonly details: string; readonly digest: string } }) => Promise<Verdict>;
    readonly outcome: (call: OutwardCall & { readonly outcome: "ok" | "error"; readonly error?: string }) => Promise<void>;
}

// The held requests, one file each under the backend's own state directory, named by the SHA-256 of their text: what an
// approval's `performer.digest` pins.
export interface HeldStore {
    readonly write: (digest: string, text: string) => Promise<void>;
    readonly read: (digest: string) => Promise<string | undefined>;
    readonly remove: (digest: string) => Promise<void>;
}

const DIGEST = /^[0-9a-f]{64}$/;

export const heldStore = (dir: string): HeldStore => {
    const fileOf = (digest: string): string => {
        if (!DIGEST.test(digest)) {
            throw new Error("not a held request's digest");
        }
        return join(dir, `${digest}.json`);
    };
    return {
        write: async (digest, text) => {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(fileOf(digest), text, { mode: 0o600 });
        },
        read: async (digest) => {
            try {
                return await readFile(fileOf(digest), "utf8");
            } catch (error) {
                // SAFETY: a failed read from node:fs is a system error carrying `code`; anything else is rethrown unread.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return undefined;
                }
                throw error;
            }
        },
        remove: async (digest) => {
            await rm(fileOf(digest), { force: true });
        },
    };
};

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

// The request exactly as it was frozen, once: the text a hold's digest is taken over and a yes approves.
export interface Frozen {
    readonly text: string;
    readonly digest: string;
}

export const freeze = (action: Action): Frozen => {
    const text = JSON.stringify(action);
    return { text, digest: digestOf(text) };
};

const requestOf = (action: Action): Request =>
    action.binary === true ? { method: action.method, bytes: Buffer.from(String(action.body), "base64") } : { method: action.method, body: action.body };

// The Activity row's fields: where it goes below Graph, to whom, and the owner's own description of it.
const callOf = (action: Action, conversationId: string | undefined): OutwardCall => {
    const call: OutwardCall = {
        id: action.account,
        action: action.key.slice(KIND.length),
        endpoint: action.path.split("?")[0] ?? action.path,
        content: action.details.slice(0, 64 * 1024),
    };
    if (action.channel !== undefined) {
        call.channel = action.channel.slice(0, 500);
    }
    if (conversationId !== undefined) {
        call.conversationId = conversationId;
    }
    return call;
};

export interface ActDeps {
    readonly graph: Graph;
    readonly outward: Outward;
    readonly held: HeldStore;
    // The conversation that asked, as the daemon's door named it to the tool.
    readonly conversationId?: string | undefined;
}

/**
 * Asks the owner's rules about one action and does what they say: allowed, it goes to Graph and its outcome is recorded;
 * denied, the rule's reason is thrown; held, the exact request stays frozen here and the daemon has drafted the approval.
 * Read only refuses before anything is asked.
 */
export const executeAction = async (deps: ActDeps, action: Action): Promise<ActionOutcome> => {
    assertWrite(deps.graph.account);
    const { text, digest } = freeze(action);
    const call = callOf(action, deps.conversationId);
    // Frozen before the daemon is asked, so an approval it drafts never names a request that is not here.
    await deps.held.write(digest, text);
    let verdict: Verdict;
    try {
        verdict = await deps.outward.ask({ ...call, hold: { summary: action.summary.length > 200 ? `${action.summary.slice(0, 199)}…` : action.summary, details: action.details, digest } });
    } catch (error) {
        await deps.held.remove(digest);
        throw error;
    }
    if (verdict.verdict === "hold" && verdict.approvalId !== undefined) {
        return { held: true, approvalId: verdict.approvalId };
    }
    await deps.held.remove(digest);
    if (verdict.verdict === "deny") {
        throw new Error(verdict.reason);
    }
    if (verdict.verdict === "hold") {
        throw new Error(`${verdict.reason}, and the sandbox drafted no approval for it: nothing was sent`);
    }
    let result: Json | undefined;
    try {
        result = await deps.graph.call<Json | undefined>(action.path, requestOf(action));
    } catch (error) {
        await deps.outward.outcome({ ...call, outcome: "error", error: errorMessage(error) });
        throw error;
    }
    await deps.outward.outcome({ ...call, outcome: "ok" });
    return { held: false, result };
};

const sameConnection = (action: Action, account: Account): boolean =>
    action.account === account.id &&
    action.tenantId === account.tenantId &&
    action.clientId === account.clientId &&
    action.authority === (account.authority || DEFAULT_AUTHORITY);

// What an approved action came to, in the approvals queue's three states (`ApprovedActionOutcome`).
export type PerformedOutcome =
    | { readonly outcome: "done"; readonly result: string }
    | { readonly outcome: "refused"; readonly error: string }
    | { readonly outcome: "uncertain"; readonly error: string };

export interface PerformDeps {
    readonly outward: Outward;
    readonly held: HeldStore;
    // The card as the daemon holds it now, credentials included; undefined when it is gone.
    readonly account: (id: string) => Promise<Account | undefined>;
    readonly graphFor: (account: Account) => Graph;
}

// What Graph answers the actions here with, where it answers anything: a created or changed event (its `webLink`), an
// uploaded file (its `webUrl`), or nothing at all (a send, a reply, a cancellation: 202).
interface Made {
    readonly id?: string;
    readonly webLink?: string;
    readonly webUrl?: string;
}

/**
 * Carries out an approved action: the one held under `digest`, still hashing to it, on the card it was proposed under,
 * unless a rule denies it now. Graph refusing it (4xx) or the sign-in failing reached nothing, so a new yes may run it
 * again; a failure past that may have gone through, and is never repeated by itself.
 */
export const performHeld = async (deps: PerformDeps, digest: string): Promise<PerformedOutcome> => {
    const text = DIGEST.test(digest) ? await deps.held.read(digest) : undefined;
    if (text === undefined) {
        return {
            outcome: "refused",
            error: "this connection holds no request under that approval (one drafted by an older version of `m365`, or already carried out): run the command again to propose it",
        };
    }
    if (digestOf(text) !== digest) {
        return { outcome: "refused", error: "the held request no longer matches what was approved" };
    }
    // SAFETY: written by `executeAction` alone from an Action, and its digest was just checked against the approved one.
    const action = JSON.parse(text) as Action;
    let account: Account | undefined;
    try {
        account = await deps.account(action.account);
    } catch (error) {
        return { outcome: "refused", error: `the Microsoft 365 connection could not be read: ${errorMessage(error)}` };
    }
    if (account === undefined || !sameConnection(action, account)) {
        return { outcome: "refused", error: "that approval belongs to a Microsoft 365 connection that is gone or now signs in elsewhere" };
    }
    if (account.access === "read") {
        return { outcome: "refused", error: "this Microsoft 365 connection is read-only now" };
    }
    const call = callOf(action, undefined);
    let verdict: Verdict;
    try {
        verdict = await deps.outward.ask(call);
    } catch (error) {
        return { outcome: "refused", error: `the sandbox's action rules could not be asked: ${errorMessage(error)}` };
    }
    if (verdict.verdict === "deny") {
        return { outcome: "refused", error: verdict.reason };
    }
    let result: Made | undefined;
    try {
        result = await deps.graphFor(account).call<Made | undefined>(action.path, requestOf(action));
    } catch (error) {
        await deps.outward.outcome({ ...call, outcome: "error", error: errorMessage(error) });
        const reachedNothing = error instanceof SignInError || (error instanceof GraphError && error.status < 500);
        return reachedNothing ? { outcome: "refused", error: errorMessage(error) } : { outcome: "uncertain", error: errorMessage(error) };
    }
    await deps.held.remove(digest);
    await deps.outward.outcome({ ...call, outcome: "ok" });
    // The row's one line: what Graph made, where it answered with one.
    return { outcome: "done", result: result?.webLink ?? result?.webUrl ?? result?.id ?? "Microsoft accepted it" };
};
