import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { signIdentity } from "@intentic/sandbox-contract/s2s";
import { type ContactNeed, type S2sContactAdd, type S2sGrants, S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { ContactRow } from "../../s2s/contacts/contacts-store.js";
import { contactNeed } from "./contact-need.js";

// An agent's ask to add or accept a contact: a card a maintainer presses, which carries the handshake out; an
// automation's turn accepts a waiting request itself only with the owner's setting on and messages only.

const MESSAGES_ONLY = S2sGrantsSchema.parse({});
const OPS = "ops.acme.example";
const document = signIdentity({ sandbox: "ops", name: "ops", host: OPS, domains: [], issuedAt: 1 }, keySetFor("ops"));

const row = (over: Partial<ContactRow> = {}): ContactRow => ({
    id: "c-ops",
    address: OPS,
    document,
    scope: { kind: "sandbox" },
    state: "pending-in",
    grants: MESSAGES_ONLY,
    notices: [],
    origin: "request",
    note: "We run the builds.",
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const harness = (options: { readonly rows?: readonly ContactRow[]; readonly mayAccept?: boolean } = {}) => {
    const added: S2sContactAdd[] = [];
    const accepted: { id: string; grants: S2sGrants }[] = [];
    const rows = [...(options.rows ?? [])];
    const kind = contactNeed({
        contact: async (id) => rows.find((held) => held.id === id),
        byAddress: async (address) => rows.find((held) => held.address === address),
        add: async (input) => {
            added.push(input);
            return row({ state: "pending-out" });
        },
        accept: async (id, grants) => {
            accepted.push({ id, grants });
            return row({ state: "accepted", grants });
        },
        agentMayAccept: async () => options.mayAccept ?? false,
    });
    return { kind, added, accepted, rows };
};

const context = { conversationId: "conv-1", standing: undefined };
const needOf = (subject: ContactNeed): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });

test("an add raises a card for the address as normalized, and the press sends the request", async () => {
    const { kind, added } = harness();
    const resolved = await kind.resolve({ kind: "contact", action: "add", address: "https://OPS.acme.example/", grants: MESSAGES_ONLY, note: "Hello" }, context);
    const subject: ContactNeed = { kind: "contact", address: OPS, action: "add", grants: MESSAGES_ONLY, note: "Hello" };
    expect(resolved).toEqual({ kind: "raise", subject, title: `Add ${OPS} as a contact` });
    expect(kind.mayAnswer?.(needOf(subject), { email: "vic@acme.test" })).toBe("Only this sandbox's owner or a maintainer adds or accepts a contact for it.");
    expect(await kind.answer(needOf(subject), { kind: "approve" }, { email: "owner@acme.test", maintainer: true })).toEqual({
        status: "met",
        result: `Asked ${OPS} to be a contact of this sandbox.`,
        use: ["It is a contact once that sandbox accepts: `messages contacts` shows its state, and a message sent before then waits for it."],
    });
    expect(added).toEqual([{ address: OPS, grants: MESSAGES_ONLY, note: "Hello" }]);
});

test("an add for a contact already there is met, and for a blocked one refused", async () => {
    expect(await harness({ rows: [row({ state: "accepted" })] }).kind.resolve({ kind: "contact", action: "add", address: OPS, grants: MESSAGES_ONLY }, context)).toEqual({
        kind: "met",
        message: `${OPS} is already a contact here (accepted).`,
    });
    expect(await harness({ rows: [row({ state: "blocked" })] }).kind.resolve({ kind: "contact", action: "add", address: OPS, grants: MESSAGES_ONLY }, context)).toEqual({
        kind: "refused",
        code: "blocked",
        message: `Nothing was asked: ${OPS} is blocked here.`,
    });
});

test("an accept raises a card unless the owner lets an automation's turn accept messages only by itself", async () => {
    const asked = harness({ rows: [row()] });
    expect(await asked.kind.resolve({ kind: "contact", action: "accept", contactId: "c-ops", grants: MESSAGES_ONLY }, context)).toEqual({
        kind: "raise",
        subject: { kind: "contact", address: OPS, action: "accept", contactId: "c-ops", grants: MESSAGES_ONLY, note: "We run the builds." },
        title: `Accept ${OPS} as a contact`,
    });
    expect(asked.accepted).toEqual([]);

    const allowed = harness({ rows: [row()], mayAccept: true });
    expect(await allowed.kind.resolve({ kind: "contact", action: "accept", contactId: "c-ops", grants: MESSAGES_ONLY }, context)).toEqual({
        kind: "met",
        message: `${OPS} is a contact of this sandbox now.`,
    });
    expect(allowed.accepted).toEqual([{ id: "c-ops", grants: MESSAGES_ONLY }]);

    // More than messages always waits for a person, setting or not.
    const wider = harness({ rows: [row()], mayAccept: true });
    const reports = { ...MESSAGES_ONLY, report: true };
    expect(await wider.kind.resolve({ kind: "contact", action: "accept", contactId: "c-ops", grants: reports }, context)).toMatchObject({ kind: "raise" });
    expect(wider.accepted).toEqual([]);
});

test("an accept names a request waiting here, and is met once the contact is accepted elsewhere", async () => {
    const { kind, rows } = harness({ rows: [row()] });
    expect(await kind.resolve({ kind: "contact", action: "accept", contactId: "c-none", grants: MESSAGES_ONLY }, context)).toEqual({
        kind: "refused",
        code: "invalid",
        message: "Nothing was asked: an accept names a contact request waiting here (`messages contacts`).",
    });
    const subject: ContactNeed = { kind: "contact", address: OPS, action: "accept", contactId: "c-ops", grants: MESSAGES_ONLY };
    expect(await kind.check(needOf(subject))).toBeUndefined();
    rows[0] = row({ state: "accepted" });
    expect(await kind.check(needOf(subject))).toEqual({ result: `${OPS} is a contact of this sandbox now.`, use: ["`messages send` reaches it, and what it sends arrives as messages."] });
});
