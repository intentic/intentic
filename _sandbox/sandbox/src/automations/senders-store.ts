import { type ListenerMessage, type SenderSeen, SenderSeenSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Who has written to each listener source (.intentic/records/senders.json): the roster the sender rules picker offers
// by name while storing the id. Kept per provider, since a Discord user id means nothing on Slack. Written for every
// message that reached an automation's filters, admitted or not, so an owner sees who tried and can name them.

// Per provider; the least recently heard is dropped first, so whoever is actually writing is never the one evicted.
export const SENDERS_KEPT = 200;

const RosterSchema = z.record(z.string(), SenderSeenSchema.omit({ id: true }));
const FileSchema = z.record(z.string(), RosterSchema);
type SendersFile = z.infer<typeof FileSchema>;

export const sendersDocument = defineDocument({ path: stateRelPath(".intentic/records/senders.json"), schema: RosterSchema, granularity: "record" });

export interface SendersStore {
    // Newest first.
    readonly list: (provider: string) => Promise<SenderSeen[]>;
    // One more message from this sender; name and groups are what the service said this time.
    readonly record: (provider: string, author: ListenerMessage["author"], now: number) => Promise<void>;
}

// Drops the least recently heard senders once over the cap; the same object back when nothing needs dropping.
const evict = (roster: SendersFile[string]): SendersFile[string] => {
    const entries = Object.entries(roster);
    if (entries.length <= SENDERS_KEPT) {
        return roster;
    }
    return Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt).slice(0, SENDERS_KEPT));
};

export const fileSendersStore = (path: string): SendersStore => {
    const file = openDocument(sendersDocument, path, { fallback: (): SendersFile => ({}) });
    return {
        list: async (provider) =>
            Object.entries((await file.read())[provider] ?? {})
                .map(([id, seen]) => ({ id, ...seen }))
                .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt),
        record: async (provider, author, now) => {
            await file.update((all) => {
                const roster = all[provider] ?? {};
                const known = roster[author.id];
                const seen: SendersFile[string][string] = {
                    name: author.name,
                    ...(author.groups !== undefined ? { groups: author.groups } : {}),
                    firstSeenAt: known?.firstSeenAt ?? now,
                    lastSeenAt: now,
                    messages: (known?.messages ?? 0) + 1,
                };
                return { ...all, [provider]: evict({ ...roster, [author.id]: seen }) };
            });
        },
    };
};
