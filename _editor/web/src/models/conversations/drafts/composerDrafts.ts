import { sandboxRef, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { ForkOfSchema, FreshOfSchema, QueuedServingSchema } from "@intentic/sandbox-contract/schemas/agent";
import { RepoBranchSchema } from "@intentic/sandbox-contract/schemas/shared";
import type { AgentReaction } from "@intentic/sandbox-contract/schemas/agents";
import type { DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { computed, type ComputedRef } from "vue";
import { z } from "zod";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { closedDraftsKey, composerDraftsKey, removeStoredValue, storedJson, storedValue, storeJson } from "../../../app/storage/browserStorage";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { staleDaemonReason, supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
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
    fromBranch: RepoBranchSchema.optional().catch(undefined),
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
    fromBranch: tab.fromBranch,
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

// The drafts whose last edit was made in this window, which makes this window their writer. Every window holds every
// draft (`held`, kept the same by `drafts` notes) and reads them all back on each `drafts` push, but only the one
// typing may write: two windows writing one draft from the same revision raced, and the loser's conflict joined both sets
// of words into the composer, so a message came out doubled and the caret jumped to its end.
const editedHere = sandboxValue(() => new Set<string>());

// The words each draft has held as somebody typed them in this browser, in any of its windows: the last few per draft.
// A revision the sandbox answers with that holds one of these is this browser's own earlier write (another window's,
// still out when this one took over), never words from another device to keep beside these.
const TYPED_KEPT = 200;
const typed = sandboxValue(() => new Map<string, string[]>());
const noteTyped = (conversationId: string, text: string): void => {
    const kept = typed.value.get(conversationId) ?? [];
    if (kept.at(-1) !== text) {
        kept.push(text);
        kept.splice(0, Math.max(0, kept.length - TYPED_KEPT));
        typed.value.set(conversationId, kept);
    }
};
const typedHere =
    (conversationId: string) =>
    (text: string): boolean =>
        typed.value.get(conversationId)?.includes(text) ?? false;

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
        // An edit made there after this window's last one makes that window the writer. The same edit time is that
        // writer relaying the sandbox's answer, which changes nobody's turn.
        if (mine !== undefined && draft.editedAt > mine.editedAt) {
            editedHere.value.delete(draft.conversationId);
        }
        if (draft.pending) {
            noteTyped(draft.conversationId, draft.text);
        }
    }
    for (const { id, editedAt } of note.gone) {
        const mine = drafts.get(id);
        if (mine !== undefined && mine.editedAt <= editedAt) {
            drafts.delete(id);
            editedHere.value.delete(id);
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

/* ---- the reader's marks on conversations not started yet ---- */

// As the sandbox last listed them (`agents.drafts` `reactions`) or answered a press, by conversation. Apart from the
// words on purpose: words clear with every emptied composer, and an open new chat has none, yet its marks stay until the
// first turn carries them onto the card. Not kept in storage: every hello and every `drafts` push reads them back.
const marks = sandboxShallowRef<ReadonlyMap<string, readonly AgentReaction[]>>(() => new Map());

const heardMarks = (conversationId: string, reactions: readonly AgentReaction[]): void => {
    const next = new Map(marks.value);
    if (reactions.length === 0) {
        next.delete(conversationId);
    } else {
        next.set(conversationId, reactions);
    }
    marks.value = next;
};

/** The reader's marks on each conversation no turn has started yet, as a draft card wears them (`reactions`). */
export const draftReactions: ComputedRef<ReadonlyMap<string, readonly AgentReaction[]>> = computed(() => marks.value);

/**
 * Puts the reader's mark on a conversation no turn has started yet, or takes it back (`agents.reactDraft`), answered with
 * the marks it now carries. `at` names another sandbox's conversation; only the one in view's marks are held here, so an
 * answer from another is the caller's to show.
 */
export const markDraft = async (conversationId: string, emoji: string, on: boolean, at?: string): Promise<readonly AgentReaction[]> => {
    if (!supportsRoute(`agents.reactDraft`)) {
        throw new Error(staleDaemonReason(`agents.reactDraft`));
    }
    const sandbox = held.value.sandbox;
    const { reactions } = await sandboxRpc.agents.reactDraft({ id: conversationId, emoji, on }, { context: { at } });
    if (at === undefined && held.value.sandbox === sandbox) {
        heardMarks(conversationId, reactions);
    }
    return reactions;
};

// A discard takes the marks with the words: the sandbox cannot tell a discard from a composer emptied by hand (both clear
// the words, and the empty one must leave the marks alone), so the press says it, one `on: false` per mark. Every window
// applies the same discard; the ones after the first find nothing left to take back.
const takeBackMarks = (conversationId: string): void => {
    const worn = marks.value.get(conversationId) ?? [];
    if (worn.length === 0) {
        return;
    }
    heardMarks(conversationId, []);
    for (const { emoji } of worn) {
        // allow(silent-catch): a take-back that does not land leaves a mark on a conversation that is gone; the next read shows it again.
        void sandboxRpc.agents.reactDraft({ id: conversationId, emoji, on: false }).catch(() => undefined);
    }
};

/** The revision of the sandbox's draft a message sent now goes out from, which the sandbox clears as it takes it. */
export const sentFrom = (conversationId: string): number | undefined => held.value.drafts.get(conversationId)?.synced?.revision;

/* ---- writing back to the sandbox ---- */

// A sandbox that answered `agents.drafts` with "no such route" keeps none, whatever its hello claimed.
const refused = sandboxRef(() => false);

/** Whether the sandbox in view holds drafts itself; one that does not leaves this browser's copy as the only one. */
export const sandboxKeepsDrafts: ComputedRef<boolean> = computed(() => supportsRoute(`agents.drafts`) && !refused.value);

// Typing pauses this long before the words are written; a send or a close in between is answered by the sandbox anyway.
const WRITE_AFTER_MS = 400;

// A copy still waiting to be written this long after its last edit has no window writing it: the one that typed it
// closed, or could not reach the sandbox. Any window may write it then, and every window's copy holds the same words by
// now, so two of them writing it costs one harmless conflict rather than a doubled message.
export const ORPHANED_AFTER_MS = 5_000;

const timers = sandboxValue(
    () => new Map<string, ReturnType<typeof setTimeout>>(),
    (previous) => previous.forEach((timer) => clearTimeout(timer)),
);
const inFlight = sandboxValue(() => new Set<string>());
const again = sandboxValue(() => new Set<string>());

/* WHAT THIS WINDOW HOLDS OF THE SANDBOX'S DRAFTS, as the daemon counts their moves (`generation`: per person, per daemon
   run). A read says the count it was taken at; each write of this window's that moved them answers with the count it
   made, which carries the window forward when it is the very next one. A `drafts` push naming no later count is the echo
   of moves held here already: reading the whole list back for it was one GET /agents/drafts per pause in typing, in the
   typist's own window (2026-11-06). A push heard while one of this window's writes is out waits for its answer, since
   it is usually that write's own. Unknown until a read says, and again after every (re)connect: a restarted daemon
   counts from zero. */
interface Counted {
    generation?: number;
    // The newest count a push named while one of this window's writes was out, decided once that write is answered.
    owed?: number;
}
const counted = sandboxValue<Counted>(() => ({}));

// A count this window has caught up to: a read's, or one of its own writes' that came right after a count it knew. Only
// for the count it was asked under (`asked`): an answer from before a reconnect may be a restarted daemon's old count.
const caughtUp = (asked: Counted, generation: number | undefined, own: boolean): void => {
    if (generation === undefined || counted.value !== asked) {
        return;
    }
    const known = counted.value.generation;
    if (!own) {
        counted.value.generation = Math.max(generation, known ?? generation);
    } else if (known !== undefined && generation === known + 1) {
        counted.value.generation = generation;
    }
};

// Whether this window writes the draft now: it edited it last, or nobody is writing it any more.
const writesHere = (draft: HeldDraft, now: number): boolean => editedHere.value.has(draft.conversationId) || now - draft.editedAt >= ORPHANED_AFTER_MS;

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
    if (sent === undefined || !sent.pending || sent.box !== undefined) {
        return;
    }
    const now = Date.now();
    if (!writesHere(sent, now)) {
        // Another window is typing it and writes it. Looked at again once it would count as left behind, in case that
        // window closes first; by then its answer has usually reached this copy and there is nothing to write.
        writeSoon(conversationId, sent.editedAt + ORPHANED_AFTER_MS - now);
        return;
    }
    if (inFlight.value.has(conversationId)) {
        again.value.add(conversationId);
        return;
    }
    if (!holdsWords(sent) && sent.synced === undefined) {
        // Words let go while their first write was out, and that write never landed: nothing there to clear.
        put(new Map([[conversationId, undefined]]));
        return;
    }
    if (!sandboxKeepsDrafts.value) {
        return;
    }
    const sandbox = held.value.sandbox;
    const asked = counted.value;
    inFlight.value.add(conversationId);
    try {
        const answer = await call(sent);
        // A switch since: the copy that went stays pending in its sandbox's storage, written when it is in view again.
        if (held.value.sandbox !== sandbox) {
            return;
        }
        // A copy gone here while the call was out was let go (sent, discarded): what the call wrote is cleared next.
        const current = held.value.drafts.get(conversationId) ?? { ...sent, text: ``, attachments: [], editedAt: Date.now() };
        const next = answered(current, sent, answer, typedHere(conversationId));
        put(new Map([[conversationId, next]]));
        caughtUp(asked, answer.generation, true);
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
        const owed = counted.value.owed;
        if (owed !== undefined && inFlight.value.size === 0) {
            counted.value.owed = undefined;
            draftsMoved(owed);
        }
    }
};

// The read under way, per sandbox: a switch mid-read leaves that read to bail out, and the next sandbox's hello reads its own.
const pulling = sandboxValue<{ read?: Promise<void> }>(() => ({}));

// Reads the sandbox's drafts back into this copy, then writes whatever this copy holds that the sandbox does not.
const pull = async (): Promise<void> => {
    if (!sandboxKeepsDrafts.value) {
        return;
    }
    const sandbox = held.value.sandbox;
    const asked = counted.value;
    try {
        const list = await sandboxRpc.agents.drafts();
        if (held.value.sandbox !== sandbox) {
            return;
        }
        caughtUp(asked, list.generation, false);
        // A sandbox older than marks on drafts lists none, and holds none to list.
        const listed = new Map(Object.entries(list.reactions ?? {}));
        if (JSON.stringify([...listed]) !== JSON.stringify([...marks.value])) {
            marks.value = listed;
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

/**
 * The sandbox says drafts moved (its `drafts` push, naming the count of moves it went out at), or it was (re)connected to
 * (no count): read them back, unless this window made every move the count names. One read at a time.
 */
export const draftsMoved = (generation?: number): void => {
    if (generation === undefined) {
        counted.value = {};
    } else {
        const known = counted.value.generation;
        if (known !== undefined && generation <= known) {
            return;
        }
        if (inFlight.value.size > 0) {
            counted.value.owed = Math.max(generation, counted.value.owed ?? generation);
            return;
        }
    }
    const slot = pulling.value;
    slot.read ??= pull().finally(() => {
        slot.read = undefined;
    });
};

/* ---- what a composer writes ---- */

const sameServes = (left: DraftWords, right: DraftWords): boolean =>
    JSON.stringify([left.serves, left.forkOf, left.freshOf, left.fromBranch]) === JSON.stringify([right.serves, right.forkOf, right.freshOf, right.fromBranch]);

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
    editedHere.value.add(conversationId);
    noteTyped(conversationId, next.text);
    // Words the sandbox never held need no clear: they simply go. Unless their first write is out: the revision it makes
    // is cleared once it is answered, or a message sent meanwhile (naming no revision) would come back as its draft.
    const kept = holdsWords(next) || next.synced !== undefined || inFlight.value.has(conversationId);
    put(new Map([[conversationId, kept ? next : undefined]]));
    writeSoon(conversationId);
};

/** Drops a conversation's unsent message everywhere, as a close of the conversation itself does, and the reader's marks on it. */
export const discardDraft = (conversationId: string): void => {
    writeDraft(conversationId, { text: ``, attachments: [] }, { box: held.value.drafts.get(conversationId)?.box });
    takeBackMarks(conversationId);
};

// Guards against a hot update re-running this module into an orphaned instance.
reloadOnHotUpdate(import.meta);
