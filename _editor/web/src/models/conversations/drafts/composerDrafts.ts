import { sandboxRef, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { ForkOfSchema, FreshOfSchema, QueuedServingSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { computed, type ComputedRef } from "vue";
import { z } from "zod";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { closedDraftsKey, composerDraftsKey, removeStoredValue, storedJson, storedValue, storeJson } from "../../../app/storage/browserStorage";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { onChatNote, postChatNote } from "../run/chatChannel";
import { readStoredTabs, type StoredTab } from "../tabs/tabSnapshot";
import { type DraftPreviews, draftPreview } from "./draftPreview";
import { answered, type DraftWords, type HeldDraft, holdsWords, pulled } from "./heldDraft";

// THE ONE PLACE A COMPOSER'S UNSENT WORDS LIVE IN THIS BROWSER, per sandbox: an optimistic copy of the drafts the sandbox
// holds (schemas/composer-drafts.ts, heldDraft.ts for the rules). Every composer reads and writes through it
// (composerBinding.ts), every window of this browser hears each change (chatChannel `drafts`), and the board draws a
// draft's card from it whether or not any chat is open. Closing a chat moves nothing: its words stay right here, so no
// window ever stands in for words on their way somewhere, and no copy can be dropped or doubled in a move. A sandbox
// older than drafts of its own never hears of them, and this copy is all there is.

const { activeSandboxId } = useSandbox();

// The copy as storage keeps it; one entry that does not read is dropped alone.
const StoredDraftSchema: z.ZodType<HeldDraft> = z.object({
    conversationId: z.string().min(1),
    text: z.string(),
    attachments: z.array(z.object({ name: z.string(), path: z.string() })).catch([]),
    serves: QueuedServingSchema.optional().catch(undefined),
    forkOf: ForkOfSchema.optional().catch(undefined),
    freshOf: FreshOfSchema.optional().catch(undefined),
    since: z.number(),
    editedAt: z.number(),
    synced: z.object({ revision: z.number(), text: z.string(), paths: z.array(z.string()) }).optional().catch(undefined),
    pending: z.boolean(),
    box: z.string().optional().catch(undefined),
});
const StoredDraftsSchema = z.object({ drafts: z.array(z.unknown()) });

// What a closed chat left in the per-browser set drafts used to live in (closedDraftsKey): the same words, for a sandbox
// to hold from now on. The stored tab named who the message was for by the tab's own picks.
const fromClosedTab = (tab: StoredTab, now: number): HeldDraft => ({
    conversationId: tab.conversationId,
    text: tab.draft ?? ``,
    attachments: tab.attachments ?? [],
    serves:
        tab.provider === undefined
            ? undefined
            : { agent: tab.provider, harness: tab.harness ?? `native`, model: tab.model, effort: tab.effort, account: tab.account },
    forkOf: tab.forkOf,
    freshOf: tab.freshOf,
    since: tab.draftAt ?? now,
    editedAt: now,
    pending: true,
    box: tab.box,
});

// The sandbox's copy, read back once per scope; the set a chat close used to keep is taken in here once and removed, so
// a draft is never in two places.
const read = (sandbox: string | undefined): Map<string, HeldDraft> => {
    if (sandbox === undefined) {
        return new Map();
    }
    const stored = (storedJson(composerDraftsKey(sandbox), StoredDraftsSchema)?.drafts ?? []).flatMap((entry) => StoredDraftSchema.safeParse(entry).data ?? []);
    const drafts = new Map(stored.map((draft) => [draft.conversationId, draft] as const));
    const legacy = storedValue(closedDraftsKey(sandbox));
    if (legacy !== undefined) {
        const now = Date.now();
        for (const tab of readStoredTabs(legacy)) {
            const draft = fromClosedTab(tab, now);
            if (!drafts.has(draft.conversationId) && holdsWords(draft)) {
                drafts.set(draft.conversationId, draft);
            }
        }
        storeJson(composerDraftsKey(sandbox), { drafts: [...drafts.values()] });
        removeStoredValue(closedDraftsKey(sandbox));
    }
    return drafts;
};

interface Held {
    readonly sandbox: string | undefined;
    readonly drafts: ReadonlyMap<string, HeldDraft>;
}

const writeOut = (held: Held): void => {
    if (held.sandbox !== undefined) {
        storeJson(composerDraftsKey(held.sandbox), { drafts: [...held.drafts.values()] });
    }
};

// The sandbox the copy belongs to rides inside it, so every write lands under the sandbox it describes. Written on every
// change, as the tab strip is, so nothing typed waits on a timer a closing page would never fire; a scope reset (a
// sandbox switch, a replaced workspace whose storage was just swept) writes nothing back.
const held = sandboxShallowRef<Held>(() => ({ sandbox: activeSandboxId.value, drafts: read(activeSandboxId.value) }));

// Applies a set of changes (undefined: gone) here, then tells storage and every other window of this browser.
const put = (changes: ReadonlyMap<string, HeldDraft | undefined>): void => {
    if (changes.size === 0) {
        return;
    }
    const drafts = new Map(held.value.drafts);
    const gone: { id: string; editedAt: number }[] = [];
    for (const [id, draft] of changes) {
        const before = drafts.get(id);
        if (draft === undefined) {
            drafts.delete(id);
            gone.push({ id, editedAt: before?.editedAt ?? Date.now() });
        } else {
            drafts.set(id, draft);
        }
    }
    held.value = { sandbox: held.value.sandbox, drafts };
    writeOut(held.value);
    postChatNote({ kind: `drafts`, changed: [...changes.values()].filter((draft) => draft !== undefined), gone });
};

// Another window's changes: of two copies of one draft, the one a window edited later wins, and an answer from the
// sandbox (which moves no edit time) lands on the copy it answered.
onChatNote(`drafts`, (note) => {
    const drafts = new Map(held.value.drafts);
    for (const draft of note.changed) {
        const mine = drafts.get(draft.conversationId);
        if (mine === undefined || draft.editedAt >= mine.editedAt) {
            drafts.set(draft.conversationId, draft);
        }
    }
    for (const { id, editedAt } of note.gone) {
        const mine = drafts.get(id);
        if (mine !== undefined && mine.editedAt <= editedAt) {
            drafts.delete(id);
        }
    }
    held.value = { sandbox: held.value.sandbox, drafts };
});

/* ---- what the app reads ---- */

/** The unsent message for one conversation, while it holds something to send. */
export const draftOf = (conversationId: string): HeldDraft | undefined => {
    const draft = held.value.drafts.get(conversationId);
    return draft !== undefined && holdsWords(draft) ? draft : undefined;
};

/** Every unsent message, whichever window or device wrote it. Moves per keystroke: read `draftFacts` to know only which. */
export const heldDrafts: ComputedRef<readonly HeldDraft[]> = computed(() => [...held.value.drafts.values()].filter(holdsWords));

/** What a board card reads of an unsent message: everything but its words. */
export interface DraftFacts {
    readonly since: number;
    readonly serves?: HeldDraft["serves"];
    readonly freshOf?: HeldDraft["freshOf"];
    readonly box?: string | undefined;
}

// Serialized, so a keystroke (which changes the words, never these) stops here instead of rebuilding the board: a
// computed compares the string it produced.
const factsKey = computed(() =>
    JSON.stringify(
        heldDrafts.value.map((draft): [string, DraftFacts] => [draft.conversationId, { since: draft.since, serves: draft.serves, freshOf: draft.freshOf, box: draft.box }]),
    ),
);

/** Which conversations hold unsent words, since when and for whom; the same object for as long as only the words change. */
export const draftFacts: ComputedRef<ReadonlyMap<string, DraftFacts>> = computed(
    // SAFETY: the string is the one `factsKey` serialized from [conversation id, facts] pairs, never anything read in.
    () => new Map(JSON.parse(factsKey.value) as [string, DraftFacts][]),
);

/** The opening words of every unsent message, by conversation, for a card's name. */
export const draftPreviews: ComputedRef<DraftPreviews> = computed(() =>
    Object.fromEntries(
        heldDrafts.value.flatMap((draft) => {
            const line = draftPreview(draft.text);
            return line === undefined ? [] : [[draft.conversationId, line] as const];
        }),
    ),
);

/** The revision of the sandbox's draft a message sent now goes out from, which the sandbox clears as it takes it. */
export const sentFrom = (conversationId: string): number | undefined => held.value.drafts.get(conversationId)?.synced?.revision;

/* ---- writing back to the sandbox ---- */

// A sandbox that answered `agents.drafts` with "no such route" keeps none, whatever its hello claimed.
const refused = sandboxRef(() => false);

/** Whether the sandbox in view holds drafts itself; one that does not leaves this browser's copy as the only one. */
export const sandboxKeepsDrafts: ComputedRef<boolean> = computed(() => supportsRoute(`agents.drafts`) && !refused.value);

// Typing pauses this long before the words are written; a send or a close in between is answered by the sandbox anyway.
const WRITE_AFTER_MS = 400;

const timers = sandboxValue(
    () => new Map<string, ReturnType<typeof setTimeout>>(),
    (previous) => previous.forEach((timer) => clearTimeout(timer)),
);
const inFlight = sandboxValue(() => new Set<string>());
const again = sandboxValue(() => new Set<string>());

const writeSoon = (conversationId: string, after = WRITE_AFTER_MS): void => {
    if (!sandboxKeepsDrafts.value) {
        return;
    }
    clearTimeout(timers.value.get(conversationId));
    timers.value.set(
        conversationId,
        setTimeout(() => void writeNow(conversationId), after),
    );
};

const call = (draft: HeldDraft): Promise<DraftWritten> =>
    holdsWords(draft)
        ? sandboxRpc.agents.writeDraft({
              id: draft.conversationId,
              text: draft.text,
              attachments: draft.attachments.map((file) => file.path),
              serves: draft.serves,
              forkOf: draft.forkOf,
              freshOf: draft.freshOf,
              since: draft.since,
              base: draft.synced?.revision,
          })
        : sandboxRpc.agents.clearDraft({ id: draft.conversationId, revision: draft.synced?.revision });

// One call per draft at a time; an edit made while one is out goes once it is answered.
const writeNow = async (conversationId: string): Promise<void> => {
    timers.value.delete(conversationId);
    const sent = held.value.drafts.get(conversationId);
    if (sent === undefined || !sent.pending || sent.box !== undefined || !sandboxKeepsDrafts.value) {
        return;
    }
    if (inFlight.value.has(conversationId)) {
        again.value.add(conversationId);
        return;
    }
    const sandbox = held.value.sandbox;
    inFlight.value.add(conversationId);
    try {
        const answer = await call(sent);
        // A switch since: the copy that went stays pending in its sandbox's storage, written when it is in view again.
        if (held.value.sandbox !== sandbox) {
            return;
        }
        const next = answered(held.value.drafts.get(conversationId) ?? sent, sent, answer);
        put(new Map([[conversationId, next]]));
        if (next?.pending === true) {
            writeSoon(conversationId, 0);
        }
    } catch (error: unknown) {
        // A write that got no answer stays pending here, which is the point of keeping a copy: it goes with the next edit,
        // the next time the sandbox says drafts moved, or when it is reached again (its hello reads them back).
        if (error instanceof SandboxHttpError && error.status === 404) {
            refused.value = true;
        }
    } finally {
        inFlight.value.delete(conversationId);
        if (again.value.delete(conversationId)) {
            writeSoon(conversationId, 0);
        }
    }
};

let pulling: Promise<void> | undefined;

// Reads the sandbox's drafts back into this copy, then writes whatever this copy holds that the sandbox does not.
const pull = async (): Promise<void> => {
    if (!sandboxKeepsDrafts.value) {
        return;
    }
    const sandbox = held.value.sandbox;
    try {
        const list = await sandboxRpc.agents.drafts();
        if (held.value.sandbox !== sandbox) {
            return;
        }
        const next = pulled(held.value.drafts, list, Date.now());
        const changes = new Map<string, HeldDraft | undefined>();
        for (const [id, draft] of next) {
            if (held.value.drafts.get(id) !== draft) {
                changes.set(id, draft);
            }
        }
        for (const id of held.value.drafts.keys()) {
            if (!next.has(id)) {
                changes.set(id, undefined);
            }
        }
        put(changes);
        for (const draft of next.values()) {
            if (draft.pending) {
                writeSoon(draft.conversationId, 0);
            }
        }
    } catch (error: unknown) {
        if (error instanceof SandboxHttpError && error.status === 404) {
            refused.value = true;
        }
        // allow(silent-catch): an unreachable sandbox is read again on its next hello; the copy here stands meanwhile.
    }
};

/** The sandbox says drafts moved (its `drafts` push), or it was (re)connected to: read them back. One read at a time. */
export const draftsMoved = (): void => {
    pulling ??= pull().finally(() => {
        pulling = undefined;
    });
};

/* ---- what a composer writes ---- */

const sameServes = (left: DraftWords, right: DraftWords): boolean =>
    JSON.stringify([left.serves, left.forkOf, left.freshOf]) === JSON.stringify([right.serves, right.forkOf, right.freshOf]);

const unchanged = (draft: HeldDraft, words: DraftWords, box: string | undefined): boolean =>
    draft.text === words.text &&
    draft.box === box &&
    draft.attachments.length === words.attachments.length &&
    draft.attachments.every((file, at) => file.path === words.attachments[at]?.path) &&
    sameServes(draft, words);

/**
 * What a composer now holds for a conversation: kept here at once, and written to the sandbox once typing pauses.
 * Empty words clear it. `since` starts a draft at an instant of its own (one carried over from before); `box` names the
 * sandbox a conversation outside the one in view lives in.
 */
export const writeDraft = (conversationId: string, words: DraftWords, options: { readonly since?: number | undefined; readonly box?: string | undefined } = {}): void => {
    const current = held.value.drafts.get(conversationId);
    if (current === undefined ? !holdsWords(words) : unchanged(current, words, options.box)) {
        return;
    }
    const now = Date.now();
    const next: HeldDraft = {
        conversationId,
        ...words,
        since: current !== undefined && holdsWords(current) ? current.since : (options.since ?? now),
        editedAt: now,
        synced: current?.synced,
        pending: true,
        box: options.box,
    };
    // Words the sandbox never held need no clear: they simply go.
    put(new Map([[conversationId, holdsWords(next) || next.synced !== undefined ? next : undefined]]));
    writeSoon(conversationId);
};

/** Drops a conversation's unsent message everywhere, as a close of the conversation itself does. */
export const discardDraft = (conversationId: string): void => {
    writeDraft(conversationId, { text: ``, attachments: [] }, { box: held.value.drafts.get(conversationId)?.box });
};

// Guards against a hot update re-running this module into an orphaned instance.
reloadOnHotUpdate(import.meta);
