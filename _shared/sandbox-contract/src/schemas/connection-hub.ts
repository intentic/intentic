import { z } from "zod";
import { KEYRING_NAME_RE } from "./keyring.js";

// THE CONNECTIONS HUB: the keyring on one of the owner's computers as the place their connections live, so a sandbox can
// put one there and any other of their sandboxes can take it. Nothing new runs on the computer: a hub item is an
// ordinary keyring `text` entry whose value is the envelope below, put there through the keyring's inbox (a person's
// yes at the computer) and shared back in `copy` mode, so a sandbox holds a sealed copy that works with the computer off
// and changes when the entry does. The sandbox turns each copy it holds into the card or account the envelope describes,
// and takes it away again when the computer stops sharing it.
//
// Only credentials that do not rotate travel. A sign-in whose refresh token is renewed (a Claude or Codex subscription,
// an OAuth card) would sign the other copies out at its first renewal, so each sandbox signs in to those itself.

// Every hub entry's name starts so; the rest is a readable slug and a random tail, since a sandbox cannot see the entries
// another put there and an inbox item under a name already taken replaces that entry.
export const HUB_ENTRY_PREFIX = "CONNECTION_";
export const isHubEntryName = (name: string): boolean => name.startsWith(HUB_ENTRY_PREFIX) && KEYRING_NAME_RE.test(name);

/** The keyring copies an agent may spend by name: every one but the hub's own, which only the daemon reads. */
export const withoutHubEntries = (copies: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
    Object.fromEntries(Object.entries(copies).filter(([name]) => !isHubEntryName(name)));

// The guard a hub entry carries as its only host. `.invalid` never resolves (RFC 2606), so the copy, which the sandbox
// keeps like any secret, can never be sent anywhere by a `{{secret:…}}` reference; and a sandbox asking for one finds it
// by this host through the keyring's ordinary need, which matches entries by host.
export const HUB_HOST_SUFFIX = "connections.invalid";

// The card kinds that travel: a CLI connector (its provider's own card), a remote tool server, a model endpoint. Every
// other kind is tied to where it was made (a computer, a disk, a link) or runs something of its own.
export const HubCardKindSchema = z.enum(["cli", "mcp", "endpoint"]);
export type HubCardKind = z.infer<typeof HubCardKindSchema>;

// The model providers whose account is a key that does not rotate: what a sign-in there would write is the whole
// account: Cursor and Devin keys, and the minted Z.ai and Meta keys. (Endpoints are cards, above.)
export const HUB_ACCOUNT_PROVIDERS = ["cursor", "devin", "zai", "meta"] as const;
export const HubAccountProviderSchema = z.enum(HUB_ACCOUNT_PROVIDERS);
export type HubAccountProvider = z.infer<typeof HubAccountProviderSchema>;

// One static account, the fields every static store keeps. Only a sandbox's daemon ever reads one.
export const StaticAccountCopySchema = z.object({
    label: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    variant: z.string().max(100).optional().describe("Which sign-in estate a minted key belongs to (Z.ai's international or mainland plan)."),
    plan: z.string().max(100).optional(),
    apiKey: z.string().min(1).max(8192),
    apiKeyExpiresAtMs: z.number().optional(),
    backendUrl: z.string().max(500).optional(),
});
export type StaticAccountCopy = z.infer<typeof StaticAccountCopySchema>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/u;

// What one hub entry holds. `card.config` carries the card's credential fields beside its settings, which the receiving
// sandbox vaults exactly as a card added there would be; it is checked against that sandbox's own card schema there.
export const HubCardItemSchema = z
    .object({
        type: z.literal("card"),
        id: z.string().min(1).max(60).describe("The card's id where it was saved, kept where it is free."),
        kind: HubCardKindSchema,
        connector: z.string().regex(SLUG_RE).optional().describe("A CLI card's connector (its `provider`), which another sandbox asks for it by."),
        config: z.record(z.string(), z.unknown()),
    })
    .strict();
export const HubAccountItemSchema = z.object({ type: z.literal("account"), provider: HubAccountProviderSchema, account: StaticAccountCopySchema }).strict();
export const HubItemSchema = z.discriminatedUnion("type", [HubCardItemSchema, HubAccountItemSchema]);
export type HubItem = z.infer<typeof HubItemSchema>;

export const ConnectionEnvelopeSchema = z
    .object({
        intentic: z.literal("connection"),
        v: z.literal(1),
        label: z.string().min(1).max(200).describe("What the connection is called, for the rows that list it."),
        from: z.object({ sandbox: z.string().max(200), at: z.number() }).strict().describe("Where and when it was saved."),
        item: HubItemSchema,
    })
    .strict();
export type ConnectionEnvelope = z.infer<typeof ConnectionEnvelopeSchema>;

// What a sandbox asks the computer for: one connector's card, any card of a kind that has no connector (a tool server,
// a model endpoint), or one provider's static account.
export const HubWantSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("card"), kind: HubCardKindSchema, connector: z.string().regex(SLUG_RE).optional() }).strict(),
    z.object({ type: z.literal("account"), provider: HubAccountProviderSchema }).strict(),
]);
export type HubWant = z.infer<typeof HubWantSchema>;

/** The host a hub entry for `want` carries, and a need for it asks by. A connector's card is found by its connector alone. */
export const hubHostOf = (want: HubWant): string => {
    if (want.type === "account") {
        return `${want.provider}.account.${HUB_HOST_SUFFIX}`;
    }
    return want.kind === "cli" && want.connector !== undefined ? `${hubSlug(want.connector)}.cli.${HUB_HOST_SUFFIX}` : `${want.kind}.${HUB_HOST_SUFFIX}`;
};

/** What a hub item answers to: the want a sandbox would ask with to be offered it. */
export const wantOfItem = (item: HubItem): HubWant => {
    if (item.type === "account") {
        return { type: "account", provider: item.provider };
    }
    return item.kind === "cli" && item.connector !== undefined ? { type: "card", kind: item.kind, connector: item.connector } : { type: "card", kind: item.kind };
};

/** A fresh entry name for an item: readable in the Passwords app, and unlikely to meet another sandbox's. */
export const hubEntryName = (item: HubItem, tail: string): string => {
    const what = item.type === "account" ? item.provider : (item.connector ?? item.kind);
    const readable = what
        .toUpperCase()
        .replace(/[^A-Z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "")
        .slice(0, 40);
    return `${HUB_ENTRY_PREFIX}${readable === "" ? "ITEM" : readable}_${tail.toUpperCase().replace(/[^A-Z0-9]/gu, "")}`;
};

/** A connector id as a hub slug: lower case, letters, digits and dashes. */
export const hubSlug = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 40) || "x";

/* THE ROUTES, called by the owner's editor. */

// What a saved or taken connection is here: a card by its id, or a provider's account by its id there.
export const HubTargetSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("card"), id: z.string().min(1).max(60) }).strict(),
    z.object({ type: z.literal("account"), provider: HubAccountProviderSchema, id: z.string().min(1).max(200) }).strict(),
]);
export type HubTarget = z.infer<typeof HubTargetSchema>;
export const sameHubTarget = (a: HubTarget, b: HubTarget): boolean =>
    a.type === "card" ? b.type === "card" && a.id === b.id : b.type === "account" && a.provider === b.provider && a.id === b.id;

// A computer whose keyring could hold the hub.
export const HubComputerSchema = z.object({
    machine: z.string(),
    online: z.boolean(),
    setUp: z.boolean().describe("Its keyring is installed and set up, so it can take a connection in."),
    locked: z.boolean().optional(),
});
export type HubComputer = z.infer<typeof HubComputerSchema>;

// One card or account held here, and whether it can go to the hub.
export const HubHoldingSchema = z.object({
    target: HubTargetSchema,
    label: z.string(),
    want: HubWantSchema.optional().describe("What another sandbox asks with to be offered it. Absent when it cannot go."),
    reason: z.string().optional().describe("Why it cannot go to the hub, in words a person can act on. Absent when it can."),
    saved: z
        .object({
            entry: z.string().regex(KEYRING_NAME_RE),
            machine: z.string(),
            at: z.number(),
            pending: z.boolean().describe("It waits for a yes at the computer (the keyring was locked when it was sent)."),
        })
        .optional()
        .describe("It was saved to the hub from here: which entry, on which computer."),
    from: z
        .object({ entry: z.string(), machine: z.string().optional() })
        .optional()
        .describe("It was made here from a hub entry: which, and the computer that shares it. It goes when that computer stops sharing it."),
});
export type HubHolding = z.infer<typeof HubHoldingSchema>;

// A hub entry shared here that could not be turned into a connection, with why.
export const HubFailureSchema = z.object({ entry: z.string(), machine: z.string().optional(), message: z.string(), at: z.number() });
export type HubFailure = z.infer<typeof HubFailureSchema>;

export const HubStateSchema = z.object({
    computers: z.array(HubComputerSchema),
    holdings: z.array(HubHoldingSchema),
    failures: z.array(HubFailureSchema),
});
export type HubState = z.infer<typeof HubStateSchema>;

export const HubSaveSchema = z.object({ target: HubTargetSchema, machine: z.string().min(1).max(128) }).strict();
export type HubSave = z.infer<typeof HubSaveSchema>;
export const HubSavedSchema = z.object({
    entry: z.string(),
    machine: z.string(),
    pending: z.boolean().describe("It waits for the next unlock at that computer, where the person says yes."),
});
export type HubSaved = z.infer<typeof HubSavedSchema>;

export const HubTakeSchema = z.object({ want: HubWantSchema, why: z.string().min(1).max(300).optional() }).strict();
export type HubTake = z.infer<typeof HubTakeSchema>;
export const HubTakenSchema = z.object({
    outcome: z.enum(["taken", "waiting", "none"]).describe("Shared and made here; waiting for a yes at the computer; nothing saved there answers it."),
    message: z.string(),
    target: HubTargetSchema.optional().describe("What it was made into here, once taken."),
});
export type HubTaken = z.infer<typeof HubTakenSchema>;
