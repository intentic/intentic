import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FieldNotes } from "@intentic/agent-context/field-notes";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { stateRelPath } from "../../state-paths.js";

// The field-notes brief a conversation was first sent, kept so its later turns send the same bytes. The brief rides
// the system prompt, the very front of the cached prefix, so a brief that changed mid-conversation (the monthly
// rewrite, a budget edit) would re-write the conversation's whole cache — history included — on its next turn. Pinned,
// new notes reach new conversations, and an old one picks them up only where its cache is already gone (a compaction).
// The project map has the same property for free: it sits in the opening message, so the history holds it.
//
// Briefs are kept once by content hash, since every conversation in a month pins one of the same handful. A cache, not
// a record: losing the file only means each conversation pins whatever its next turn reads.

const FieldNotesSchema = z.object({
    text: z.string(),
    chars: z.number(),
    revision: z.string(),
    unlisted: z.array(z.string()),
    ranksSent: z.number(),
    ranksTotal: z.number(),
    writtenAt: z.number(),
});

const PinsSchema = z.object({
    briefs: z.record(z.string(), FieldNotesSchema),
    pins: z.record(z.string(), z.object({ brief: z.string(), at: z.number() })),
});
type Pins = z.infer<typeof PinsSchema>;

export const fieldNotesPinsDocument = defineDocument({ path: stateRelPath(".intentic/local/cache/", "field-notes-pins.json"), schema: PinsSchema });

// Far more conversations than are ever live at once; the oldest pins go first, and an evicted conversation only pays
// what it would have paid without a pin.
const KEPT = 2000;

const keyOf = (brief: FieldNotes): string => createHash("sha256").update(brief.text).digest("hex").slice(0, 16);

// Newest KEPT pins, and only the briefs one of them names.
const pruned = ({ briefs, pins }: Pins): Pins => {
    const kept = Object.entries(pins)
        .sort(([, left], [, right]) => right.at - left.at)
        .slice(0, KEPT);
    const named = new Set(kept.map(([, pin]) => pin.brief));
    return {
        pins: Object.fromEntries(kept),
        briefs: Object.fromEntries(Object.entries(briefs).filter(([key]) => named.has(key))),
    };
};

export interface FieldNotesPins {
    // The brief pinned to the conversation, else to the one it forked from (a fork carries its parent's prefix).
    readonly pinned: (conversationId: string, forkOf: string | undefined) => Promise<FieldNotes | undefined>;
    readonly pin: (conversationId: string, brief: FieldNotes) => Promise<void>;
}

const fileFieldNotesPins = (path: string): FieldNotesPins => {
    const file = openDocument(fieldNotesPinsDocument, path, { fallback: (): Pins => ({ briefs: {}, pins: {} }) });
    return {
        pinned: async (conversationId, forkOf) => {
            const { briefs, pins } = await file.read();
            const pin = pins[conversationId] ?? (forkOf === undefined ? undefined : pins[forkOf]);
            return pin === undefined ? undefined : briefs[pin.brief];
        },
        pin: async (conversationId, brief) => {
            const key = keyOf(brief);
            await file.update((current) =>
                current.pins[conversationId]?.brief === key
                    ? current
                    : pruned({ briefs: { ...current.briefs, [key]: { ...brief, unlisted: [...brief.unlisted] } }, pins: { ...current.pins, [conversationId]: { brief: key, at: Date.now() } } }),
            );
        },
    };
};

// One store per workspace for the daemon's life: turn facts reach it by root, so no service has to carry it.
const opened = new Map<string, FieldNotesPins>();
export const fieldNotesPinsAt = (root: string): FieldNotesPins => {
    const known = opened.get(root);
    if (known !== undefined) {
        return known;
    }
    const pins = fileFieldNotesPins(join(root, fieldNotesPinsDocument.path));
    opened.set(root, pins);
    return pins;
};
