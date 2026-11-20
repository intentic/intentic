/* WHAT EACH CREDENTIAL'S PLAN INCLUDES, as the translator registers it: the model ids it routes to that credential alone.
   Plans differ within one provider: a ChatGPT Free sign-in runs Luna, a Team one Sol and Astra too, and the
   translator turns a request for a model a credential's plan lacks away before anything goes upstream. The account rows
   carry each list (TranslatorAccount.models), and the one serviceability rule reads an account whose list lacks a model
   other accounts run as off that model's plan (plan-pools.ts serviceStates). Without it, two Free sign-ins with all their
   allowance left read ready for Sol, and a held Sol turn went round every two minutes for two hours (2026-11-19).

   A list changes only with the plan or the translator's catalog, while the rows are read on every pick, so each list is
   kept and handed out as held, and re-read in the background once it is older than MAX_AGE_MS. Only a credential never
   read waits on the translator. An empty or failed read is no list: it judges nothing.

   THE TRANSLATOR'S LISTS ARE ITS OWN TABLE OF WHAT EACH PLAN INCLUDES, NOT THE PROVIDER'S, and the two disagree. On
   2026-11-20 CLIProxyAPI 8.0.79 listed GPT-6.1-Terra and GPT-6 Chat Thinking for both ChatGPT Free sign-ins, ChatGPT
   answered every request for either on them with "The 'gpt-6.1-terra' model is not supported when using Codex with a
   ChatGPT account.", and the picker kept offering both on the strength of that list while every turn on them failed.
   So the gateway reports each such refusal here (`refused`), and the model is taken off that credential's list, whatever
   the translator says, for REFUSED_FOR_MS: long enough that a plan's refusal is believed for days, short enough that a
   plan the provider widens is tried again. Kept on disk, since the translator's table comes back unchanged with every
   restart, and so would the failed turn that taught it. */

import { z } from "zod";
import type { JsonFile } from "../../store/json-file.js";
import { cacheFile } from "../../store/open-document.js";
import { PINNED_MODEL_ID } from "./translator-prefixes.js";

// How long a credential's list stands before the next read of the rows asks again, in the background.
const MAX_AGE_MS = 10 * 60_000;

// How long the provider's refusal of a model on one credential takes that model off the credential's list.
export const REFUSED_FOR_MS = 3 * 24 * 60 * 60_000;

// Each credential's refused models, with when each was refused (ms): what the file beside the credentials holds.
const RefusedModelsSchema = z.record(z.string(), z.record(z.string(), z.number()));
export type RefusedModels = Readonly<Record<string, Readonly<Record<string, number>>>>;

// Where the provider's refusals are kept: a file the daemon regrows from the next refusal when it cannot read one.
export const refusedModelsFile = (path: string): JsonFile<RefusedModels> =>
    cacheFile<RefusedModels>(path, {
        parse: (raw) => {
            const read = RefusedModelsSchema.safeParse(raw);
            return read.success ? read.data : undefined;
        },
        fallback: () => ({}),
    });

export interface CredentialModels {
    // Each named credential's list, where the translator gave one: held lists at once, unread ones read first. Never
    // rejects; a credential with no list is left out.
    readonly of: (names: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
    // Reads one credential's list again, now: the translator turned a request for a model away from it, so the held list
    // may be out of date.
    readonly recheck: (name: string) => void;
    // The provider refused `model` on this credential as off its plan: it leaves the credential's list until
    // REFUSED_FOR_MS has passed. Never rejects; a record that cannot be kept on disk still holds until a restart.
    readonly refused: (name: string, model: string) => Promise<void>;
    // The models the provider refused on any of these credentials that none of their lists still carries: what the
    // translator's own model listing goes on offering, on the strength of its table, that none of them can run.
    readonly withdrawn: (names: readonly string[]) => Promise<string[]>;
}

interface Held {
    readonly at: number;
    readonly models: readonly string[] | undefined;
}

export const createCredentialModels = (params: {
    // The translator's model ids for one credential; empty when it cannot say.
    readonly read: (name: string) => Promise<readonly string[]>;
    // Where the provider's refusals are kept across restarts; none keeps them in memory alone.
    readonly store?: JsonFile<RefusedModels> | undefined;
    readonly now?: () => number;
}): CredentialModels => {
    const now = params.now ?? Date.now;
    const held = new Map<string, Held>();
    const reading = new Map<string, Promise<Held>>();

    // Read from the store once, then kept here and written through.
    let refusals: Promise<RefusedModels> | undefined;
    // allow(silent-catch): an unreadable store holds no refusals, which leaves the translator's lists as they are.
    const loaded = (): Promise<RefusedModels> => (refusals ??= (params.store?.read() ?? Promise.resolve({})).catch((): RefusedModels => ({})));
    // The models refused on one credential that still stand.
    const standing = (all: RefusedModels, name: string): ReadonlySet<string> =>
        new Set(Object.entries(all[name] ?? {}).flatMap(([model, at]) => (now() - at < REFUSED_FOR_MS ? [model] : [])));
    const withoutRefused = (all: RefusedModels, name: string, models: readonly string[] | undefined): readonly string[] | undefined => {
        const refused = standing(all, name);
        return models === undefined || refused.size === 0 ? models : models.filter((model) => !refused.has(model));
    };
    // Every refusal that still stands, the expired ones dropped.
    const pruned = (all: RefusedModels): RefusedModels =>
        Object.fromEntries(
            Object.entries(all).flatMap(([name, models]) => {
                const kept = Object.entries(models).filter(([, at]) => now() - at < REFUSED_FOR_MS);
                return kept.length === 0 ? [] : [[name, Object.fromEntries(kept)]];
            }),
        );

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

    const of = async (names: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> => {
        const all = await loaded();
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
        return new Map(
            lists.flatMap(([name, listed]) => {
                const models = withoutRefused(all, name, listed);
                return models === undefined ? [] : [[name, models] as const];
            }),
        );
    };

    return {
        of,
        recheck: (name) => void load(name),
        refused: async (name, model) => {
            // Chained onto the last, so two refusals in flight together both stand.
            const next = loaded().then((all) => pruned({ ...all, [name]: { ...all[name], [model]: now() } }));
            refusals = next;
            const kept = await next;
            // allow(silent-catch): the refusal holds in memory; the next one written carries it to disk.
            await params.store?.update(() => kept).catch(() => undefined);
        },
        withdrawn: async (names) => {
            const [all, lists] = await Promise.all([loaded(), of(names)]);
            const carried = new Set([...lists.values()].flat());
            return [...new Set(names.flatMap((name) => [...standing(all, name)]))].filter((model) => !carried.has(model));
        },
    };
};
