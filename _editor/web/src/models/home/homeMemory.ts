import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import type { Conversation } from "../conversations/session/conversation";

// HOW FULL A HOME CONVERSATION'S MEMORY IS, AND THE TWO WAYS TO EMPTY IT. A home is one chat kept for good, so the
// daemon opens its next turn in a fresh session once its context passes the sandbox's `homeFreshOver` (handoff.ts
// FreshStartSchema): a summary and its latest messages instead of all of it re-read on every call. Its person reads
// how close that is, and may start fresh now or clear the history outright (agents.startFreshHome / clearHomeHistory).

// From here the readout says the fresh start is near, so the next one does not arrive unannounced.
export const FRESH_SOON_PERCENT = 80;

/**
 * What the readout says: the next message starts fresh (`pending`); how much of the budget the context fills
 * (`fill`); or, under a budget of zero that never starts fresh by itself, no figure at all (`unbudgeted`), which still
 * leads to the two presses. Undefined with nothing to say: no card, nothing read into memory yet, or a sandbox that
 * names no budget (older than fresh starts).
 */
export type HomeMemoryReading =
    | { readonly kind: `pending`; readonly why: NonNullable<AgentSummary["freshPending"]> }
    | { readonly kind: `fill`; readonly percent: number; readonly soon: boolean }
    | { readonly kind: `unbudgeted` };

export const homeMemoryReading = (
    card: Pick<AgentSummary, "contextTokens" | "freshPending"> | undefined,
    budget: number | undefined,
): HomeMemoryReading | undefined => {
    if (card === undefined || budget === undefined) {
        return undefined;
    }
    if (card.freshPending !== undefined) {
        return { kind: `pending`, why: card.freshPending };
    }
    if (card.contextTokens === undefined) {
        return undefined;
    }
    if (budget <= 0) {
        return { kind: `unbudgeted` };
    }
    const percent = Math.min(100, Math.round((card.contextTokens / budget) * 100));
    return { kind: `fill`, percent, soon: percent >= FRESH_SOON_PERCENT };
};

/** The readout for a card on a home, against the sandbox's budget; nothing for any other card, or a sandbox without it. */
export const useHomeMemory = (card: () => Pick<AgentSummary, "home" | "contextTokens" | "freshPending"> | undefined) => {
    const { settings } = useSandboxSettings();
    const budget = computed(() => settings.value?.homeFreshOver);
    const reading = computed(() =>
        card()?.home === true && supportsRoute(`agents.startFreshHome`) ? homeMemoryReading(card(), budget.value) : undefined,
    );
    return { budget, reading };
};

/**
 * Whether the card is the reader's own home: the presses act on the caller's home and take no id, so they are offered
 * only on it, never on another person's a sandbox owner may be reading. A courtesy, like every reach test here: with no
 * email to compare (a loopback session), or no verified starter on the card, it reads as the reader's.
 */
export const ownHome = (card: Pick<AgentSummary, "home" | "startedBy"> | undefined, me: string | undefined): boolean =>
    card?.home === true && (me === undefined || card.startedBy === undefined || card.startedBy.toLowerCase() === me.toLowerCase());

// Either press, asked of the sandbox: undefined once done, else why not in the reader's words. A turn holds the home
// (the daemon takes its rewind lease for both), or whatever the sandbox said.
const ask = async <T>(call: () => Promise<T>): Promise<string | undefined> => {
    try {
        await call();
        return undefined;
    } catch (error) {
        return error instanceof SandboxHttpError && error.status === 409 ? t(`chat.homeMemory.busy`) : messageOr(error, t(`chat.homeMemory.failed`));
    }
};

/** The parts of the home's conversation either press touches. */
export type HomeChat = Pick<Conversation, "box" | "session"> & { readonly transcript: Pick<Conversation["transcript"], "clearRecord"> };

/** Makes the caller's own home start fresh on its next message; undefined once done, else why not. */
export const startFreshHome = async (conversation: HomeChat): Promise<string | undefined> => {
    const refused = await ask(() => sandboxRpc.agents.startFreshHome(undefined, { context: { at: conversation.box.value } }));
    if (refused === undefined) {
        // The daemon let the old session go; a ref kept here would name it to the next turn as the one to resume.
        conversation.session.value = undefined;
    }
    return refused;
};

/**
 * Deletes the caller's own home's history, and empties this window's copy of it (transcriptView.clearRecord): every
 * read after this answers an empty record, which a redraw never takes for one. Undefined once done, else why not.
 */
export const clearHomeHistory = async (conversation: HomeChat): Promise<string | undefined> => {
    const refused = await ask(() => sandboxRpc.agents.clearHomeHistory(undefined, { context: { at: conversation.box.value } }));
    if (refused === undefined) {
        await conversation.transcript.clearRecord();
    }
    return refused;
};
