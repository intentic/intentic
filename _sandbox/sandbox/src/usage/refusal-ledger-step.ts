import { join } from "node:path";
import { parseJsonOr } from "@intentic/base/json";
import { AccountUsageSchema, type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { defineStep } from "../store/evolution/state-steps.js";
import { providerRefusalsDocument } from "./provider-refusals.js";

// The two refusal copies retired on 2026-10-20 when every refusal became one ledger (provider-refusals.ts): a routed
// model's bench (model-cooldowns.json, `provider:model` → until) and a plan-less account's run-outs and hand marks
// (observed-limits.json, `provider:account` → model → refusal, `*` for the account refused outright). What either still
// holds is filed in the ledger as the refusal it stood for, and both files go. So does the projection of the second into
// account-usage.json (`observed:` pools, which no reading retires), since the verdict now reads the ledger itself.
// Their shapes are spelled here rather than through each store, which no longer exists.
const COOLDOWNS = "model-cooldowns.json";
const OBSERVED = "observed-limits.json";
const READINGS = "account-usage.json";
const OBSERVED_POOL = "observed:";
const ACCOUNT_WIDE = "*";

const CooldownsSchema = z.record(z.string(), z.object({ until: z.number(), message: z.string(), since: z.number().optional() }));
const ObservedSchema = z.record(
    z.string(),
    z.record(z.string(), z.object({ at: z.number(), message: z.string(), byHand: z.literal(true).optional(), refused: z.literal("entitlement").optional() })),
);
const LedgerSchema = z.record(z.string(), ProviderRefusalSchema);
const ReadingsSchema = z.record(z.string(), AccountUsageSchema);

// A retired file as its schema reads it; one that does not parse holds nothing worth filing.
const parsed = <T extends z.ZodType>(schema: T, raw: string | undefined): z.infer<T> | undefined =>
    raw === undefined ? undefined : schema.safeParse(parseJsonOr(raw, undefined)).data;

// A key's provider and the rest, split at the first colon: no provider's name holds one.
const split = (key: string): readonly [string, string] => [key.slice(0, Math.max(0, key.indexOf(":"))), key.slice(key.indexOf(":") + 1)];

// `provider:model` → its bench: the fleet's spent allowance on that model, until then.
const fromCooldowns = (stored: z.infer<typeof CooldownsSchema>): [string, ProviderRefusal][] =>
    Object.entries(stored).flatMap(([key, cooldown]) => {
        const [provider, model] = split(key);
        const refusal: ProviderRefusal = { at: cooldown.since ?? cooldown.until, kind: "limit", message: cooldown.message, model, resetsAt: Math.ceil(cooldown.until / 1000) };
        return provider === "" ? [] : [[`${provider}:limit::${model}`, refusal]];
    });

// `provider:account` → model → its run-out on that model, or (`*`) the account refused outright.
const fromObserved = (stored: z.infer<typeof ObservedSchema>): [string, ProviderRefusal][] =>
    Object.entries(stored).flatMap(([key, ledger]) => {
        const [provider, account] = split(key);
        return provider === ""
            ? []
            : Object.entries(ledger).map(([model, limit]): [string, ProviderRefusal] => {
                  if (model === ACCOUNT_WIDE) {
                      return [`${provider}:entitlement:${account}:`, { at: limit.at, kind: "entitlement", message: limit.message, account }];
                  }
                  const refusal: ProviderRefusal = { at: limit.at, kind: "limit", message: limit.message, account, model };
                  if (limit.byHand === true) {
                      refusal.byHand = true;
                  }
                  return [`${provider}:limit:${account}:${model}`, refusal];
              });
    });

// The readings with their `observed:` pools taken out, an account left with none dropped; undefined where none had any.
const withoutObserved = (readings: z.infer<typeof ReadingsSchema> | undefined): z.infer<typeof ReadingsSchema> | undefined => {
    const observed = (usage: z.infer<typeof AccountUsageSchema>): boolean => usage.windows.some((window) => window.kind.startsWith(OBSERVED_POOL));
    if (readings === undefined || !Object.values(readings).some(observed)) {
        return undefined;
    }
    return Object.fromEntries(
        Object.entries(readings).flatMap(([account, usage]) => {
            const own = usage.windows.filter((window) => !window.kind.startsWith(OBSERVED_POOL));
            return own.length === 0 ? [] : [[account, { ...usage, windows: own }]];
        }),
    );
};

const json = (value: z.infer<typeof LedgerSchema> | z.infer<typeof ReadingsSchema>): string => `${JSON.stringify(value, null, 2)}\n`;

export const refusalLedgerStep = defineStep({
    id: "refusal-ledger",
    describe: "files what the retired model cooldowns and observed limits held in the one refusal ledger, and deletes both",
    plan: async ({ roots, read, kind }) => {
        const at = (name: string): string => join(roots.history, name);
        const retired = [at(COOLDOWNS), at(OBSERVED)];
        const present = (await Promise.all(retired.map(async (path) => ((await kind(path)) === "file" ? [path] : [])))).flat();
        if (present.length === 0) {
            return undefined;
        }
        const folded = [
            ...fromCooldowns(parsed(CooldownsSchema, await read(at(COOLDOWNS))) ?? {}),
            ...fromObserved(parsed(ObservedSchema, await read(at(OBSERVED))) ?? {}),
        ];
        const ledgerPath = at(providerRefusalsDocument.path);
        // What the ledger already holds for a scope is newer than either retired copy, so it wins.
        const ledger = { ...Object.fromEntries(folded), ...parsed(LedgerSchema, await read(ledgerPath)) };
        const readings = withoutObserved(parsed(ReadingsSchema, await read(at(READINGS))));
        const writes = new Map<string, string | undefined>(present.map((path) => [path, undefined]));
        if (folded.length > 0) {
            writes.set(ledgerPath, json(ledger));
        }
        if (readings !== undefined) {
            writes.set(at(READINGS), json(readings));
        }
        return { changes: [`files ${folded.length} retired refusal(s) in the refusal ledger and deletes the copies they were kept in`], writes };
    },
});
