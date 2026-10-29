import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

/* Who connected each AI account this sandbox holds itself (agent/routes/accounts.routes.ts): the lowercased address of
 * the person whose sign-in brought it here, keyed by the account's key (`aiAccountKey`, `claude:work`). An account a
 * person connected is always theirs to run on, even where their roster row lists only some AI accounts
 * (access/principal-chain.ts), and theirs to rename or disconnect when all they hold is the own-accounts right. Under the
 * history root beside the roster, where no workspace write reaches: a turn must not be able to name itself an account's
 * connector. */

const ConnectorSchema = z.object({ by: z.string(), at: z.number() });
const ConnectorsSchema = z.object({ connectors: z.record(z.string(), ConnectorSchema) });
type Connectors = z.infer<typeof ConnectorsSchema>;

export const accountConnectorsDocument = defineDocument({
    root: "history",
    path: "identity/account-connectors.json",
    // Names people on this sandbox's own roster, which does not travel either.
    portability: "identity",
    note: "People connect their own AI accounts again on the target, which records them as theirs.",
    schema: ConnectorsSchema,
});

export interface AccountConnectorsStore {
    /** Every recorded connector: the account's key to the address that connected it. */
    readonly all: () => Promise<ReadonlyMap<string, string>>;
    /** Records who connected this account; a later sign-in onto the same account replaces it. */
    readonly record: (key: string, email: string, at: number) => Promise<void>;
    /** Takes the record away, once the account is disconnected. */
    readonly forget: (key: string) => Promise<void>;
    /** The keys of every account this person connected. */
    readonly keysOf: (email: string) => Promise<readonly string[]>;
}

const byKey = (connectors: Connectors): ReadonlyMap<string, string> =>
    new Map(Object.entries(connectors.connectors).map(([key, connector]) => [key, connector.by]));

// The keys one person connected, out of every record; shared with the memory store so both answer alike.
export const keysBy = (connectors: ReadonlyMap<string, string>, email: string): string[] =>
    [...connectors].filter(([, by]) => by === email.toLowerCase()).map(([key]) => key);

export const fileAccountConnectors = (historyRoot: string): AccountConnectorsStore => {
    // Every handle on one path shares its write queue (queueOnFile), so a handle per call is enough.
    const file = () =>
        openDocument(accountConnectorsDocument, join(historyRoot, accountConnectorsDocument.path), { fallback: (): Connectors => ({ connectors: {} }) });
    return {
        all: async () => byKey(await file().read()),
        record: async (key, email, at) => {
            await file().update((current) => ({ connectors: { ...current.connectors, [key]: { by: email.toLowerCase(), at } } }));
        },
        forget: async (key) => {
            await file().update((current) => ({ connectors: Object.fromEntries(Object.entries(current.connectors).filter(([held]) => held !== key)) }));
        },
        keysOf: async (email) => keysBy(byKey(await file().read()), email),
    };
};
