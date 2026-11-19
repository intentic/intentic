/* WHAT EACH CREDENTIAL'S PLAN INCLUDES, as the translator registers it: the model ids it routes to that credential alone.
   Plans differ within one provider: a ChatGPT Free sign-in runs Terra and Luna, a Team one Sol and Astra too, and the
   translator turns a request for a model a credential's plan lacks away before anything goes upstream. The account rows
   carry each list (TranslatorAccount.models), and the one serviceability rule reads an account whose list lacks a model
   other accounts run as off that model's plan (plan-pools.ts serviceStates). Without it, two Free sign-ins with all their
   allowance left read ready for Sol, and a held Sol turn went round every two minutes for two hours (2026-11-19).

   A list changes only with the plan or the translator's catalog, while the rows are read on every pick, so each list is
   kept and handed out as held, and re-read in the background once it is older than MAX_AGE_MS. Only a credential never
   read waits on the translator. An empty or failed read is no list: it judges nothing. */

import { PINNED_MODEL_ID } from "./translator-prefixes.js";

// How long a credential's list stands before the next read of the rows asks again, in the background.
const MAX_AGE_MS = 10 * 60_000;

export interface CredentialModels {
    // Each named credential's list, where the translator gave one: held lists at once, unread ones read first. Never
    // rejects; a credential with no list is left out.
    readonly of: (names: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
    // Reads one credential's list again, now: the translator turned a request for a model away from it, so the held list
    // may be out of date.
    readonly recheck: (name: string) => void;
}

interface Held {
    readonly at: number;
    readonly models: readonly string[] | undefined;
}

export const createCredentialModels = (params: {
    // The translator's model ids for one credential; empty when it cannot say.
    readonly read: (name: string) => Promise<readonly string[]>;
    readonly now?: () => number;
}): CredentialModels => {
    const now = params.now ?? Date.now;
    const held = new Map<string, Held>();
    const reading = new Map<string, Promise<Held>>();

    // The bare ids only: every model is listed a second time under the credential's own prefix, which names nothing new.
    const load = (name: string): Promise<Held> => {
        const running = reading.get(name);
        if (running !== undefined) {
            return running;
        }
        const read = params
            .read(name)
            // allow(silent-catch): a list that cannot be read is no list, which judges nothing.
            .catch(() => [])
            .then((ids) => {
                const bare = ids.filter((id) => !PINNED_MODEL_ID.test(id));
                const entry: Held = { at: now(), models: bare.length === 0 ? undefined : bare };
                held.set(name, entry);
                return entry;
            })
            .finally(() => reading.delete(name));
        reading.set(name, read);
        return read;
    };

    return {
        of: async (names) => {
            const lists = await Promise.all(
                names.map(async (name) => {
                    const entry = held.get(name);
                    if (entry === undefined) {
                        return [name, (await load(name)).models] as const;
                    }
                    if (now() - entry.at > MAX_AGE_MS) {
                        void load(name);
                    }
                    return [name, entry.models] as const;
                }),
            );
            return new Map(lists.flatMap(([name, models]) => (models === undefined ? [] : [[name, models] as const])));
        },
        recheck: (name) => void load(name),
    };
};
