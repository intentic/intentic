import { reloadOnHotUpdate } from "../../../app/hotReload";
import { useSandbox } from "../../sandbox/client/useSandbox";
import type { Summons } from "./summon";
import type { Strip } from "../tabs/tabFacts";
import type { StoredTab } from "../tabs/tabSnapshot";

// One BroadcastChannel for everything the chat tells the app's other windows: a board gesture (summon.ts), the drawing
// window's strip (chatEcho.ts), and closed chats with a message set aside (closedDrafts.ts). One channel guarantees one
// delivery order and one sandbox guard, applied on the envelope rather than by each reader. Queued turns and full draft
// text never ride it.

export type ChatNote =
    // A gesture made outside the panel, for every window's panel to apply.
    | { readonly kind: `summons`; readonly summons: Summons }
    // What the drawing window is showing, for windows that aren't; a full snapshot, never a patch.
    | { readonly kind: `strip`; readonly strip: Strip }
    // Asks "what are you showing" on boot or sandbox switch, since asking is cheaper than waiting for the next change.
    | { readonly kind: `roll` }
    // The whole set of chats closed with a message still in them.
    | { readonly kind: `closed-drafts`; readonly tabs: readonly StoredTab[] };

// Which sandbox's chats the note is about, then the note; undefined means unresolved, matching only another such
// window.
export interface ChatEnvelope {
    readonly sandbox: string | undefined;
    readonly note: ChatNote;
}

type NoteOf<K extends ChatNote["kind"]> = Extract<ChatNote, { kind: K }>;

// One reader per kind, installed by the module that owns it; a Map so this file names none of them and a re-imported
// module just takes over.
const readers = new Map<ChatNote["kind"], (note: ChatNote) => void>();

/** Reads every note of one kind arriving from another window. */
export const onChatNote = <K extends ChatNote["kind"]>(kind: K, read: (note: NoteOf<K>) => void): void => {
    readers.set(kind, read as (note: ChatNote) => void);
};

// Guarded like every channel here: no BroadcastChannel (tests, SSR) just means a single-window app.
const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.chat`);

/**
 * Never delivers to its own poster, so a module wanting the note applied here must apply it itself. Posted as JSON,
 * since a Vue proxy fails structured clone; this also drops StoredTab's undefined optional fields to match a restored
 * tab's shape.
 */
export const postChatNote = (note: ChatNote): void => {
    if (channel === undefined) {
        return;
    }
    const envelope: ChatEnvelope = { sandbox: useSandbox().activeSandboxId.value, note };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel.postMessage(JSON.parse(JSON.stringify(envelope)) as ChatEnvelope);
};

/** The one way a note comes in, so a test-supplied note and a channel-delivered one take the identical path. */
export const receiveChatNote = (envelope: ChatEnvelope): void => {
    if (envelope.sandbox !== useSandbox().activeSandboxId.value) {
        return;
    }
    readers.get(envelope.note.kind)?.(envelope.note);
};

channel?.addEventListener(`message`, (event: MessageEvent<ChatEnvelope>) => receiveChatNote(event.data));

// One channel and reader set per window; a hot-reloaded rerun would leave the old listener feeding a stale store.
reloadOnHotUpdate(import.meta);
