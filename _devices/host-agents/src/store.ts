import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { renameOver, stagingOf, writeFileAtomicSync } from "@intentic/base/fs";
import { parseJsonOr } from "@intentic/base/json";
import { type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract/events/transcript";
import { isConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { z } from "zod";

// A CONVERSATION ON THIS COMPUTER, AS IT IS KEPT: one JSON file each under the reader's own home
// (`~/.intentic/host-agents/conversations/<id>.json`), holding the card's facts and every settled row. The harness
// keeps its own session beside its own sign-in (`sessionId` names it); this file is what the chat draws when the
// conversation is opened again, and what remains if the harness has let that session go.
//
// Kept whole and small on purpose: a sandbox's daemon keeps a compressed record log, a conversations database and a
// run journal because many agents and many readers share it. Here one reader's conversations are written when a turn
// ends, by the one process that runs them.

const StoredStatusSchema = z.enum([`idle`, `stopped`, `error`, `interrupted`]);

// A row another build wrote in a shape this one no longer reads is left out rather than failing the whole record.
const rowsSchema = z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row): TranscriptRow[] => {
        const parsed = TranscriptRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
    }),
);

export const StoredConversationSchema = z.object({
    v: z.literal(1),
    id: z.string().refine(isConversationId),
    // The folder it works in, as the window that opened it was granted it: the real path on this side.
    folder: z.string().min(1),
    title: z.string().optional(),
    // The harness it runs on, by id (harnesses.ts).
    provider: z.string().min(1),
    model: z.string().optional(),
    effort: z.string().optional(),
    // The harness's own session behind the last turn.
    sessionId: z.string().optional(),
    status: StoredStatusSchema,
    failure: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    seenAt: z.number().optional(),
    archivedAt: z.number().optional(),
    turns: z.number().int().nonnegative(),
    toolUses: z.number().int().nonnegative(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    rows: rowsSchema,
});
export type StoredConversation = z.infer<typeof StoredConversationSchema>;

export interface ConversationStore {
    // Every record that reads, newest first. One that does not parse is left where it is and skipped.
    readonly load: () => Promise<StoredConversation[]>;
    readonly save: (conversation: StoredConversation) => Promise<void>;
    // The same write, finished before it returns: for a process on its way out, which waits for nothing.
    readonly saveNow: (conversation: StoredConversation) => void;
    readonly remove: (id: string) => Promise<void>;
}

export const conversationStore = (home: string, log: (line: string) => void): ConversationStore => {
    const dir = join(home, `conversations`);
    const fileOf = (id: string): string => join(dir, `${id}.json`);
    // Owner-only: a transcript holds whatever the reader and the agent said and read.
    const MODE = 0o600;
    // Each conversation's newest write, by number. A turn keeps its record several times in a moment (opened, its
    // session known, settled) and each write is its own file renamed into place, so an older one could land last: one
    // that finds a newer write was asked for since lets go of its own instead of landing.
    const newest = new Map<string, number>();
    const numbered = (id: string): number => {
        const number = (newest.get(id) ?? 0) + 1;
        newest.set(id, number);
        return number;
    };
    return {
        load: async () => {
            const names = await readdir(dir).catch(undefinedIfMissing);
            const read = await Promise.all(
                (names ?? [])
                    .filter((name) => name.endsWith(`.json`))
                    .map(async (name) => {
                        const text = await readFile(join(dir, name), `utf8`).catch(undefinedIfMissing);
                        const parsed = StoredConversationSchema.safeParse(text === undefined ? undefined : parseJsonOr(text, undefined));
                        if (!parsed.success && text !== undefined) {
                            log(`skipping ${name}: not a conversation this build reads`);
                        }
                        return parsed.success ? [parsed.data] : [];
                    }),
            );
            return read.flat().toSorted((a, b) => b.updatedAt - a.updatedAt);
        },
        save: async (conversation) => {
            const number = numbered(conversation.id);
            await mkdir(dir, { recursive: true });
            const staged = stagingOf(fileOf(conversation.id));
            await writeFile(staged, `${JSON.stringify(conversation)}\n`, { mode: MODE });
            if (newest.get(conversation.id) === number) {
                await renameOver(staged, fileOf(conversation.id));
            } else {
                await rm(staged, { force: true });
            }
        },
        saveNow: (conversation) => {
            numbered(conversation.id);
            mkdirSync(dir, { recursive: true });
            writeFileAtomicSync(fileOf(conversation.id), `${JSON.stringify(conversation)}\n`, MODE);
        },
        remove: async (id) => {
            await rm(fileOf(id), { force: true });
        },
    };
};
