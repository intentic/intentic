import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { signIdentity } from "@intentic/sandbox-contract/s2s";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { opt } from "../opt.js";
import type { ContactRow } from "../s2s/contacts/contacts-store.js";
import { type ContactSends, contactDestination } from "./contact-children.js";

// `delegate(to)` names a contact exactly by its id or address; a bare name finds one only while no other sandbox (another
// contact, or a link card) answers to it, so a contact cannot name itself into a link card's or another contact's place.

const GIVES_TASKS = S2sGrantsSchema.parse({ task: { approve: false, turnsPerHour: 5 } });

const contact = (id: string, name: string, over: Partial<ContactRow> = {}): ContactRow => ({
    id,
    address: `${id}.example`,
    document: signIdentity({ sandbox: id, name, host: `${id}.example`, domains: [], issuedAt: 1 }, keySetFor(id)),
    scope: { kind: "sandbox" },
    state: "accepted",
    grants: S2sGrantsSchema.parse({}),
    theirGrants: GIVES_TASKS,
    notices: [],
    origin: "request",
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const sendsOf = (rows: readonly ContactRow[]): ContactSends => unstubbed<ContactSends>("sends", { usable: async () => rows });
const cardsOf =
    (...cards: Capability[]) =>
    async (): Promise<readonly Capability[]> =>
        cards;
const card = (id: string, sandboxId?: string): Capability => ({ id, kind: "link", config: { url: `https://${id}.test`, token: "ilk_x", ...opt("sandboxId", sandboxId) } });

const destinationOf = async (rows: readonly ContactRow[], to: string, cards = cardsOf()) => {
    const where = await contactDestination(sendsOf(rows), cards, "conv-1", { to });
    return where === undefined ? undefined : "refused" in where ? where.refused : where.contact.id;
};

test("an id or an address names its contact exactly, whatever other contact or card shares its name", async () => {
    const rows = [contact("c-prod", "prod"), contact("c-evil", "prod")];
    expect(await destinationOf(rows, "c-prod", cardsOf(card("prod")))).toBe("c-prod");
    expect(await destinationOf(rows, "c-evil.example", cardsOf(card("prod")))).toBe("c-evil");
});

test("a bare name finds a contact only while no other sandbox answers to it", async () => {
    expect(await destinationOf([contact("c-ops", "ops")], "ops")).toBe("c-ops");
    // Two sandboxes' contacts both called "prod": refused, naming both.
    expect(await destinationOf([contact("c-prod", "prod"), contact("c-evil", "Prod")], "prod")).toBe(
        '"prod" names more than one sandbox this conversation may hand work to: prod (c-prod.example), Prod (c-evil.example). Name the contact by its address or id (`messages contacts` lists them), or the link card by its id with `via`.',
    );
    // A contact named as a link card is: refused, never put in the card's place.
    expect(await destinationOf([contact("c-evil", "prod")], "prod", cardsOf(card("prod")))).toBe(
        '"prod" names more than one sandbox this conversation may hand work to: prod (c-evil.example), link card "prod". Name the contact by its address or id (`messages contacts` lists them), or the link card by its id with `via`.',
    );
    // Unless the card is for the very sandbox the contact's pairing vouched for.
    expect(await destinationOf([contact("c-prod", "prod", { vouchedSandbox: "sb-prod" })], "prod", cardsOf(card("prod", "sb-prod")))).toBe("c-prod");
    // A contact that gives no tasks still shares the name.
    expect(await destinationOf([contact("c-ops", "ops"), contact("c-quiet", "ops", { theirGrants: S2sGrantsSchema.parse({}) })], "ops")).toBe(
        '"ops" names more than one sandbox this conversation may hand work to: ops (c-ops.example), ops (c-quiet.example). Name the contact by its address or id (`messages contacts` lists them), or the link card by its id with `via`.',
    );
});

test("one sandbox's two contacts, its own and a person's, are one name: a hand-over takes the sandbox's", async () => {
    const own = contact("c-ops", "ops");
    const persons = { ...contact("c-ops-ada", "ops"), document: own.document, scope: { kind: "person", person: "ada@acme.test" } } satisfies ContactRow;
    expect(await destinationOf([persons, own], "ops")).toBe("c-ops");
});
