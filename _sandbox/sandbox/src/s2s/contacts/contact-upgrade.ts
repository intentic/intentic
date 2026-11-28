import { parseJsonOr } from "@intentic/base/json";
import { type S2sContactScope, type S2sGrants, type S2sUpgradeAnswer, S2sUpgradeAnswerSchema, type SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { opt } from "../../opt.js";
import { grantsFor } from "./contact-view.js";
import { cleared, type ContactRefusal, type ContactsCore } from "./contacts.js";
import type { ContactRow } from "./contacts-store.js";

// A CONTACT AN OLD CREDENTIAL VOUCHED FOR (docs/architecture/messages.md, "Across versions"): a link's token or a route
// pairing's secret already proves both sides to each other, so when both speak s2s/1 it is turned into a contact without
// anyone pairing again. Both sides file their half here: the taking side from the asker's confirmed document, the asking
// side from the answer. The credential vouches for the key once: an existing row for the same sandbox in the same scope
// is accepted with that key, and its grants keep everything it had plus what the credential carried, so an upgrade never
// takes away what a person gave. Once is all: the retired credential only reads that answer again (repeatedUpgrade), for
// a short while and for the very key it vouched for, and never files or changes a contact again.

export interface Vouched {
    readonly address: string;
    // Confirmed at its own address (contact-confirm.ts): the key pinned.
    readonly document: SandboxIdentity;
    readonly scope: S2sContactScope;
    // What this sandbox lets it do here: the credential's terms.
    readonly grants: S2sGrants;
    // What it says it lets this sandbox do there; informational.
    readonly theirGrants?: S2sGrants | undefined;
    // The wake secret it handed over, when it grants this sandbox `wake`.
    readonly wake?: string | undefined;
    // This sandbox's own name for it: the link card's, the link's label.
    readonly name?: string | undefined;
    readonly origin: "link-upgrade" | "pairing-upgrade";
    // The sandbox id the credential's own party vouched for (contacts-store.ts vouchedSandboxOf): the pass's, the link's
    // peer, the platform's answer. Absent when only the document says it.
    readonly vouchedSandbox?: string | undefined;
}

/** Two grant sets together: each switch on where either has it on, the task terms already held kept over the new ones. */
const grantsUnion = (held: S2sGrants, added: S2sGrants): S2sGrants => {
    const task = held.task ?? added.task;
    return {
        message: held.message || added.message,
        report: held.report || added.report,
        ...opt("task", task),
        records: held.records || added.records,
        operate: held.operate || added.operate,
        wake: held.wake || added.wake,
    };
};

// The row this sandbox already keeps for that sandbox in that scope: by its address, else by the key it pinned.
const heldFor = async (core: ContactsCore, vouched: Vouched): Promise<ContactRow | undefined> =>
    (await core.deps.store.find(vouched.address, vouched.scope)) ??
    (await core.deps.store.list()).find(
        (row) =>
            row.document.fingerprint === vouched.document.fingerprint &&
            (row.scope.kind === "sandbox" ? vouched.scope.kind === "sandbox" : vouched.scope.kind === "person" && row.scope.person.toLowerCase() === vouched.scope.person.toLowerCase()),
    );

/** Files (or files again: a repeat finds the same row) the accepted contact an upgrade makes; a blocked one is refused. */
export const fileVouched = async (core: ContactsCore, vouched: Vouched): Promise<ContactRow | ContactRefusal> => {
    const held = await heldFor(core, vouched);
    if (held?.state === "blocked") {
        return { refused: `${vouched.address} is blocked here: remove the block first`, status: 409 };
    }
    const fields = {
        document: vouched.document,
        state: "accepted" as const,
        ...opt("theirGrants", vouched.theirGrants),
        ...opt("vouchedSandbox", vouched.vouchedSandbox ?? held?.vouchedSandbox),
    };
    const row = await core.deps.store.put(
        held === undefined
            ? core.newRow({ address: vouched.address, scope: vouched.scope, origin: vouched.origin, grants: vouched.grants, ...opt("name", vouched.name), ...fields })
            : core.touch(cleared(held, ["note", "pending"]), { ...fields, grants: grantsFor(grantsUnion(held.grants, vouched.grants), held.scope) }),
    );
    await core.deps.secrets.setTheirs(row.id, vouched.wake);
    await core.deps.outbox.kickContact(row.id);
    return row;
};

// How long a retired credential answers a repeat of its upgrade: long enough for an asker that never heard the first
// answer to ask again, never long enough to be a second credential.
export const UPGRADE_REPEAT_MS = 15 * 60 * 1000;

// What a credential's record keeps of the upgrade it made: the contact, when, and the key it vouched for.
export interface UpgradedMark {
    readonly contact: string;
    readonly at: number;
    readonly fingerprint?: string | undefined;
}

/**
 * A repeat of an upgrade already made, under the retired credential: the answer it gave, read again, nothing filed or
 * changed. Undefined once the window is over (or for a mark from before the key was kept), which the door answers as it
 * does a credential it never held; refused while the posted key is another, or the contact it became was removed, blocked
 * or re-keyed since.
 */
export const repeatedUpgrade = async (core: ContactsCore, mark: UpgradedMark, posted: SandboxIdentity, now: number): Promise<S2sUpgradeAnswer | ContactRefusal | undefined> => {
    if (mark.fingerprint === undefined || now - mark.at > UPGRADE_REPEAT_MS) {
        return undefined;
    }
    if (posted.fingerprint !== mark.fingerprint) {
        return { refused: "this credential was already upgraded into a contact for another key: pair the two sandboxes again", status: 409 };
    }
    const row = await core.deps.store.get(mark.contact);
    if (row?.state !== "accepted" || row.document.fingerprint !== mark.fingerprint) {
        return { refused: "this credential became a contact here that has since been removed, blocked or changed: pair the two sandboxes again", status: 409 };
    }
    const wake = row.grants.wake ? await core.deps.secrets.inbound() : undefined;
    if (wake !== undefined) {
        await core.handedWake(row.id);
    }
    return { contact: row.id, document: await core.deps.identity().document(), grants: row.grants, ...opt("wake", wake) };
};

// What one try came to: done, a far side from before contacts (left on the old path, untouched), not now, or refused.
export type UpgradeOutcome =
    | { readonly kind: "upgraded"; readonly contact: string }
    | { readonly kind: "old"; readonly why: string }
    | { readonly kind: "later"; readonly why: string }
    | { readonly kind: "refused"; readonly why: string };

// What a door says when it refuses: `{ error, code? }`.
const RefusalSchema = z.object({ error: z.string(), code: z.string().optional() });

/** The far answer to an upgrade (a link's or a pairing's), read as an outcome; the answer itself when it was taken. */
export const readUpgradeAnswer = async (response: Response): Promise<S2sUpgradeAnswer | UpgradeOutcome> => {
    const body = parseJsonOr(await response.text(), undefined);
    const refusal = RefusalSchema.safeParse(body).data;
    const error = refusal?.error ?? `it answered ${response.status}`;
    const code = refusal?.code;
    if (response.ok) {
        const answer = S2sUpgradeAnswerSchema.safeParse(body);
        return answer.success ? answer.data : { kind: "refused", why: "it answered in a shape this build does not read" };
    }
    // A build from before the door: the bare "unauthorized" every route it does not know answers (where a door words its
    // own refusals, account-routing/route-client.ts tooOld), or the 501 of one declared but not served yet.
    if ((response.status === 401 && error === "unauthorized") || response.status === 404 || response.status === 501) {
        return { kind: "old", why: "its build does not take this upgrade yet" };
    }
    if (response.status === 429 || response.status >= 500 || code === "pass" || code === "unready") {
        return { kind: "later", why: error };
    }
    return { kind: "refused", why: code === undefined ? error : `${error} (${code})` };
};
