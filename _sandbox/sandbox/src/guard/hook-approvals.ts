import { join } from "node:path";
import { type HookRequests, HookScriptSchema, SettingsHookSchema, type TurnNote } from "@intentic/sandbox-contract";
import { z } from "zod";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { defineDocument } from "../store/evolution/documents.js";
import { approvalLedgers, type JsonFile, jsonFile } from "../store/json-file.js";
import { type HookPlace, type HookSet, settingsHookSet } from "./settings-hooks.js";

/* The owner's yes to a set of Claude Code hooks (settings-hooks.ts), pinned by its digest, and the sets turns found still
 * waiting for one. Both files sit under the history root: an agent writes the hooks, so their approval must live where no
 * workspace write reaches. A ledger this build cannot read approves nothing. */

const LedgerSchema = z.object({
    approved: z.record(z.string(), z.object({ approvedAt: z.number(), hooks: z.array(SettingsHookSchema) })),
});

export const hookApprovalsDocument = defineDocument({ root: "history", path: "hook-approvals.json", schema: LedgerSchema });

const StoredRequestSchema = z.object({
    seenAt: z.number(),
    conversationId: z.string().optional(),
    hooks: z.array(SettingsHookSchema),
    scripts: z.array(HookScriptSchema),
    dismissed: z.boolean().optional(),
});
const RequestsSchema = z.object({ requests: z.record(z.string(), StoredRequestSchema) });
type Requests = z.infer<typeof RequestsSchema>;

export const hookRequestsDocument = defineDocument({ root: "history", path: "hook-requests.json", schema: RequestsSchema });

// Newest kept: an older set nobody answered is one the workspace has since moved past.
const REQUESTS_KEPT = 20;

const ledgers = approvalLedgers((raw) => LedgerSchema.safeParse(raw).data, hookApprovalsDocument);

// Keyed by the set's digest, which is the whole pin: a set changed in any way is a new key, unapproved.
const ledgerOf = (historyRoot: string) => ledgers(join(historyRoot, "hook-approvals.json"));

// Memoized per path, so every writer of one file shares its update queue (json-file.ts).
const requestFiles = new Map<string, JsonFile<Requests>>();

const requestsOf = (historyRoot: string): JsonFile<Requests> => {
    const path = join(historyRoot, "hook-requests.json");
    const file =
        requestFiles.get(path) ??
        jsonFile<Requests>(path, {
            parse: (raw) => RequestsSchema.safeParse(raw).data,
            fallback: () => ({ requests: {} }),
            document: hookRequestsDocument,
        });
    requestFiles.set(path, file);
    return file;
};

const approved = async (historyRoot: string, digest: string): Promise<boolean> => (await ledgerOf(historyRoot).read()).approved[digest] !== undefined;

// Files the set once, so a set found by every turn raises one request; a dismissed one stays dismissed.
const requestApproval = async (historyRoot: string, set: HookSet, conversationId: string | undefined, now: number): Promise<void> => {
    let raised = false;
    await requestsOf(historyRoot).update((current) => {
        if (current.requests[set.digest] !== undefined) {
            return current;
        }
        raised = true;
        const request = { seenAt: now, ...(conversationId === undefined ? {} : { conversationId }), hooks: [...set.hooks], scripts: [...set.scripts] };
        const newest = Object.entries({ ...current.requests, [set.digest]: request })
            .toSorted(([, left], [, right]) => right.seenAt - left.seenAt)
            .slice(0, REQUESTS_KEPT);
        return { requests: Object.fromEntries(newest) };
    });
    if (raised) {
        publishRuntimeChange("approvals");
    }
};

export interface HookGate {
    // Hooks exist and this exact set is not approved: the turn runs with every hook off.
    readonly held: boolean;
    readonly set: HookSet | undefined;
}

export const gateSettingsHooks = async (historyRoot: string, place: HookPlace, conversationId: string | undefined, now = Date.now()): Promise<HookGate> => {
    const set = await settingsHookSet(place);
    if (set === undefined || (await approved(historyRoot, set.digest))) {
        return { held: false, set };
    }
    await requestApproval(historyRoot, set, conversationId, now);
    return { held: true, set };
};

// Said to the model and shown on the message, so neither reads a hook that did not fire as a broken one.
export const HOOKS_HELD_NOTE: TurnNote = {
    title: "Workspace hooks are off this turn",
    text: "Claude Code's settings or skills here (.claude/ or ~/.claude/) declare hooks the owner has not approved in their current form, so this turn runs with every hook switched off. The owner approves them under Approvals, and they run from the turn after that.",
};

// The owner's list: unanswered sets newest first, dismissed ones after them, none the ledger already approves.
export const hookRequests = async (historyRoot: string): Promise<HookRequests> => {
    const [stored, ledger] = await Promise.all([requestsOf(historyRoot).read(), ledgerOf(historyRoot).read()]);
    const requests = Object.entries(stored.requests)
        .filter(([digest]) => ledger.approved[digest] === undefined)
        .map(([digest, request]) => ({ digest, ...request }))
        .toSorted((left, right) => Number(left.dismissed ?? false) - Number(right.dismissed ?? false) || right.seenAt - left.seenAt);
    return { requests, ...(ledger.unreadable ? { ledgerUnreadable: true } : {}) };
};

// Pins a set a turn found; false when no turn found one by that digest, so a digest is never approved unseen.
export const approveHookSet = async (historyRoot: string, digest: string, now = Date.now()): Promise<boolean> => {
    const request = (await requestsOf(historyRoot).read()).requests[digest];
    if (request === undefined) {
        return false;
    }
    await ledgerOf(historyRoot).update((pins) => ({ ...pins, [digest]: { approvedAt: now, hooks: request.hooks } }));
    await requestsOf(historyRoot).update(({ requests: { [digest]: _approved, ...rest } }) => ({ requests: rest }));
    publishRuntimeChange("approvals");
    return true;
};

// Keeps a set off without asking again; false when no turn found one by that digest.
export const dismissHookSet = async (historyRoot: string, digest: string): Promise<boolean> => {
    let found = false;
    await requestsOf(historyRoot).update((current) => {
        const request = current.requests[digest];
        if (request === undefined || request.dismissed === true) {
            found = request !== undefined;
            return current;
        }
        found = true;
        return { requests: { ...current.requests, [digest]: { ...request, dismissed: true } } };
    });
    if (found) {
        publishRuntimeChange("approvals");
    }
    return found;
};
