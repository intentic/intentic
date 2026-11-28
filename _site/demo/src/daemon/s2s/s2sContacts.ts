import {
    type S2sContact,
    type S2sContactAdd,
    type S2sContactChange,
    type S2sGrants,
    S2sGrantsSchema,
    type S2sGrantsInput,
    type S2sPaired,
    type S2sPairingAnswer,
    type S2sPairingRequest,
} from "@intentic/sandbox-contract/schemas/s2s";
import { refuse } from "@intentic/contract-serve";
import { DEMO_USER } from "../../platform";
import { LAPTOP_SANDBOX } from "../../world/sandboxRegistry";
import { fingerprintOf, identityDocument, LAPTOP_HOST } from "./s2sIdentity";

// The contacts each sandbox of the demo's world keeps, as the daemon's contact store keeps them: a research sandbox that
// rotated its key last week, a partner's sandbox whose request waits on a person, the owner's laptop paired as their own
// route, a billing sandbox whose key changed with no proof, one asked and not yet answered, and a blocked relay. Adding,
// accepting, re-granting, trusting, blocking and removing write here, so the list reads what the last press left.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const grants = (input: S2sGrantsInput = {}): S2sGrants => S2sGrantsSchema.parse(input);

const contact = (id: string, address: string, name: string, more: Partial<S2sContact> = {}): S2sContact => ({
    id,
    address,
    name,
    host: address,
    domains: [],
    fingerprint: fingerprintOf(id),
    scope: { kind: `sandbox` },
    state: `accepted`,
    grants: grants(),
    holdsWake: false,
    notices: [],
    origin: `request`,
    createdAt: Date.now() - 40 * DAY,
    updatedAt: Date.now() - 2 * DAY,
    ...more,
});

const shopContacts = (): S2sContact[] => [
    contact(`research`, `research-7f2.intentic.app`, `research-desk`, {
        grants: grants({ report: true, task: { approve: true, turnsPerHour: 20 } }),
        theirGrants: grants({ report: true, wake: true }),
        holdsWake: true,
        fingerprint: fingerprintOf(`research#2`),
        notices: [{ kind: `rotated`, at: Date.now() - 6 * DAY, from: fingerprintOf(`research`), to: fingerprintOf(`research#2`), seen: false }],
        lastSeenAt: Date.now() - 52 * MINUTE,
    }),
    contact(`northwind`, `ops.northwind.example`, `northwind-ops`, {
        state: `pending-in`,
        host: `northwind-ops-3a9.intentic.app`,
        domains: [`ops.northwind.example`],
        note: `Hi, this is Northwind's fulfilment sandbox. We'd like to send you order exceptions (damaged parcels, address problems) as messages with the carrier's photos attached.`,
        theirGrants: grants({ report: true }),
        createdAt: Date.now() - 3 * HOUR,
        updatedAt: Date.now() - 3 * HOUR,
    }),
    contact(`ada-laptop`, LAPTOP_HOST, LAPTOP_SANDBOX.name, {
        scope: { kind: `person`, person: DEMO_USER.email },
        origin: `paired`,
        fingerprint: identityDocument(new URL(LAPTOP_SANDBOX.origin)).fingerprint,
        theirGrants: grants(),
        lastSeenAt: Date.now() - 20 * HOUR,
    }),
    contact(`billing`, `billing.acme-partners.example`, `billing-partners`, {
        state: `key-changed`,
        pendingKey: fingerprintOf(`billing#unproven`),
        lastSeenAt: Date.now() - 4 * DAY,
    }),
    contact(`pricing`, `pricing-lab-c41.intentic.app`, `pricing-lab`, {
        state: `pending-out`,
        createdAt: Date.now() - DAY,
        updatedAt: Date.now() - DAY,
    }),
    contact(`relay`, `relay.bulk-mail.example`, `relay.bulk-mail.example`, { state: `blocked`, updatedAt: Date.now() - 9 * DAY }),
];

// The contacts each sandbox holds, by its daemon's address; anything but the laptop is this sandbox.
const books = new Map<string, S2sContact[]>();
const bookAt = (at: URL): string => (at.origin === LAPTOP_SANDBOX.origin ? `laptop` : `shop`);
const contactsAt = (at: URL): S2sContact[] => {
    const key = bookAt(at);
    const held = books.get(key) ?? (key === `shop` ? shopContacts() : []);
    books.set(key, held);
    return held;
};
const write = (at: URL, next: S2sContact[]): void => {
    books.set(bookAt(at), next);
};

export const contactsList = (at: URL) => ({ contacts: contactsAt(at).map((each) => ({ ...each })) });

export const contactOf = (at: URL, id: string): S2sContact => contactsAt(at).find((each) => each.id === id) ?? refuse(`No contact here is called ${id}.`, 404);

const replace = (at: URL, id: string, change: (held: S2sContact) => S2sContact): S2sContact => {
    const next = change(contactOf(at, id));
    write(
        at,
        contactsAt(at).map((each) => (each.id === id ? next : each)),
    );
    return next;
};

const slug = (address: string): string =>
    address
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, `-`)
        .replace(/^-+|-+$/gu, ``)
        .slice(0, 60) || `contact`;

// The handshake, as far as this side goes: the address resolved (here: taken as typed), its key pinned, a request sent.
export const addContact = (at: URL, add: S2sContactAdd): S2sContact => {
    const address = add.address.trim().toLowerCase();
    if (contactsAt(at).some((each) => each.address === address)) {
        refuse(`${address} is already a contact here.`, 409);
    }
    const made = contact(slug(address), address, address.split(`.`)[0] ?? address, {
        state: `pending-out`,
        grants: grants(add.grants),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    write(at, [...contactsAt(at), made]);
    return made;
};

export const changeContact = (at: URL, id: string, change: S2sContactChange): S2sContact =>
    replace(at, id, (held) => {
        const next: S2sContact = { ...held, updatedAt: Date.now(), name: change.name ?? held.name };
        const update = change.grants;
        if (update !== undefined) {
            if (update.operate === true && held.scope.kind === `person`) {
                refuse(`Only a contact that is a sandbox as itself may operate this one.`, 400);
            }
            const merged: S2sGrants = {
                message: update.message ?? held.grants.message,
                report: update.report ?? held.grants.report,
                records: update.records ?? held.grants.records,
                operate: update.operate ?? held.grants.operate,
                wake: update.wake ?? held.grants.wake,
            };
            const task = update.task === undefined ? held.grants.task : update.task;
            if (task !== null && task !== undefined) {
                merged.task = task;
            }
            next.grants = merged;
        }
        return next;
    });

export const removeContact = (at: URL, id: string) => {
    contactOf(at, id);
    write(
        at,
        contactsAt(at).filter((each) => each.id !== id),
    );
    return { ok: true as const };
};

export const acceptContact = (at: URL, id: string, given: S2sGrantsInput): S2sContact =>
    replace(at, id, (held) => {
        if (held.state !== `pending-in`) {
            refuse(`${held.name} is not waiting for an answer.`, 409);
        }
        const { note: _note, ...rest } = held;
        return { ...rest, state: `accepted`, grants: grants(given), updatedAt: Date.now() };
    });

export const blockContact = (at: URL, id: string): S2sContact => replace(at, id, (held) => ({ ...held, state: `blocked`, updatedAt: Date.now() }));

export const trustKey = (at: URL, id: string, fingerprint: string): S2sContact =>
    replace(at, id, (held) => {
        if (held.pendingKey !== fingerprint) {
            refuse(`That is not the key waiting for ${held.name}.`, 409);
        }
        const { pendingKey: _pending, ...rest } = held;
        return { ...rest, state: `accepted`, fingerprint, updatedAt: Date.now() };
    });

// The far half of an editor pairing, on the sandbox being paired with: an accepted contact for the one that asked.
export const pairHere = (at: URL, request: S2sPairingRequest): S2sPairingAnswer => {
    const id = slug(request.document.name);
    const filed = contact(id, request.document.host, request.document.name, {
        fingerprint: request.document.fingerprint,
        scope: request.scope === `person` ? { kind: `person`, person: DEMO_USER.email } : { kind: `sandbox` },
        grants: grants(request.grants),
        theirGrants: grants(request.theirGrants),
        origin: `paired`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    write(at, [...contactsAt(at).filter((each) => each.id !== id), filed]);
    return { contact: id, document: identityDocument(at), grants: filed.grants };
};

// The near half: the far answer filed here.
export const paired = (at: URL, { answer, scope, grants: given }: S2sPaired): S2sContact => {
    const id = slug(answer.document.name);
    const filed = contact(id, answer.document.host, answer.document.name, {
        fingerprint: answer.document.fingerprint,
        scope: scope === `person` ? { kind: `person`, person: DEMO_USER.email } : { kind: `sandbox` },
        grants: grants(given),
        theirGrants: answer.grants,
        holdsWake: answer.wake !== undefined,
        origin: `paired`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    write(at, [...contactsAt(at).filter((each) => each.id !== id), filed]);
    return filed;
};
