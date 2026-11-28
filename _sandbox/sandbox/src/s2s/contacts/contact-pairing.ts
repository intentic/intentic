import { normalizeAddress, speaksS2s, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import type {
    S2sContactScope,
    S2sGrants,
    S2sPaired,
    S2sPairingAnswer,
    S2sPairingRequest,
    SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../../opt.js";
import type { S2sAsker } from "../askers.js";
import { grantsFor } from "./contact-view.js";
import { cleared, type ContactRefusal, type ContactsCore } from "./contacts.js";
import type { ContactRow } from "./contacts-store.js";

// PAIRING (docs/architecture/messages.md, "Two ways to make one"): one person signed in to both sandboxes. The editor reads
// this sandbox's document (GET /s2s/me) and posts it to the other one under the person's session there
// (POST /s2s/pairings, pairIn below), which files an accepted contact and answers its own document, wake secret and
// grants; the editor hands that answer back here (POST /s2s/contacts/paired, pairOut). No message crosses and nothing is
// fetched from an address: each side pins the other's key from a document read over the person's own sessions. A
// sandbox-scoped pairing is a maintainer's press on both sides; a person-scoped one is that person's own route. The
// `wake` grant hands over this sandbox's wake secret, so a person below collaborator here pairs without it (the grant is
// dropped, never refused: the rest of the pairing still holds).

// Who may pair in this scope, and the scope the contact is filed under.
const scopeFor = (asker: S2sAsker, scope: "sandbox" | "person"): S2sContactScope | ContactRefusal => {
    if (asker.kind !== "person") {
        return { refused: "pairing is a person's press, signed in to both sandboxes", status: 403 };
    }
    if (scope === "sandbox" && !asker.maintainer) {
        return { refused: "pairing this sandbox as itself is its owner's or a maintainer's: pair as yourself instead", status: 403 };
    }
    return scope === "sandbox" ? { kind: "sandbox" } : { kind: "person", person: asker.email };
};

// The other sandbox's document, checked: it verifies, speaks s2s/1, and is not this sandbox's own.
const documentProblem = (document: SandboxIdentity, ours: SandboxIdentity): ContactRefusal | undefined => {
    const check = verifyIdentity(document);
    if (!check.ok) {
        return { refused: `that sandbox's identity does not verify: ${check.reason}`, status: 400 };
    }
    if (!speaksS2s(document)) {
        return { refused: "that sandbox does not speak s2s/1", status: 409 };
    }
    return document.fingerprint === ours.fingerprint ? { refused: "that is this sandbox", status: 400 } : undefined;
};

interface Pairing {
    readonly document: SandboxIdentity;
    readonly scope: S2sContactScope;
    readonly grants: S2sGrants;
    readonly theirGrants?: S2sGrants | undefined;
    readonly wake?: string | undefined;
}

// Files (or files again) the accepted contact a pairing makes, keeping the wake secret it handed over. Both documents were
// read over the person's own sessions, so the sandbox id it names is vouched for (contacts-store.ts vouchedSandboxOf).
const filePaired = async (core: ContactsCore, pairing: Pairing): Promise<ContactRow | ContactRefusal> => {
    const address = normalizeAddress(pairing.document.host) ?? pairing.document.host;
    const held = await core.deps.store.find(address, pairing.scope);
    if (held?.state === "blocked") {
        return { refused: `${address} is blocked here: remove the block first`, status: 409 };
    }
    const fields = {
        document: pairing.document,
        state: "accepted" as const,
        grants: grantsFor(pairing.grants, pairing.scope),
        ...opt("theirGrants", pairing.theirGrants),
        vouchedSandbox: pairing.document.sandbox,
    };
    const row = await core.deps.store.put(
        held === undefined ? core.newRow({ address, scope: pairing.scope, origin: "paired", ...fields }) : core.touch(cleared(held, ["note", "pending"]), fields),
    );
    await core.deps.secrets.setTheirs(row.id, pairing.wake);
    await core.deps.outbox.kickContact(row.id);
    return row;
};

// The grants a pairing gives, `wake` dropped for a person who may not hand the secret over.
const grantsWaking = (grants: S2sGrants, mayWake: boolean): S2sGrants => (mayWake ? grants : { ...grants, wake: false });

/** POST /s2s/pairings, on the sandbox being paired with: files the contact and answers this side's half. */
export const pairIn = async (core: ContactsCore, request: S2sPairingRequest, asker: S2sAsker, mayWake: boolean): Promise<S2sPairingAnswer | ContactRefusal> => {
    const scope = scopeFor(asker, request.scope);
    if ("refused" in scope) {
        return scope;
    }
    const ours = await core.deps.identity().document();
    const problem = documentProblem(request.document, ours);
    if (problem !== undefined) {
        return problem;
    }
    const row = await filePaired(core, { document: request.document, scope, grants: grantsWaking(request.grants, mayWake), theirGrants: request.theirGrants, wake: request.wake });
    if ("refused" in row) {
        return row;
    }
    const wake = row.grants.wake ? await core.deps.secrets.inbound() : undefined;
    if (wake !== undefined) {
        await core.handedWake(row.id);
    }
    return { contact: row.id, document: ours, grants: row.grants, ...opt("wake", wake) };
};

/** POST /s2s/contacts/paired, back on the first sandbox: files its half from the other's answer. */
export const pairOut = async (core: ContactsCore, paired: S2sPaired, asker: S2sAsker, mayWake: boolean): Promise<ContactRow | ContactRefusal> => {
    const scope = scopeFor(asker, paired.scope);
    if ("refused" in scope) {
        return scope;
    }
    const problem = documentProblem(paired.answer.document, await core.deps.identity().document());
    if (problem !== undefined) {
        return problem;
    }
    const row = await filePaired(core, { document: paired.answer.document, scope, grants: grantsWaking(paired.grants, mayWake), theirGrants: paired.answer.grants, wake: paired.answer.wake });
    if ("refused" in row) {
        return row;
    }
    // The editor carried no wake secret of this side's over there, so the contact is handed it now when it may hold one.
    if (row.grants.wake) {
        await core.send(row, { kind: "contact.update", grants: row.grants, wake: await core.deps.secrets.inbound() });
    }
    return row;
};
