import { normalizeAddress, speaksS2s } from "@intentic/sandbox-contract/s2s";
import type { DropSend, DropSendOutcome } from "@intentic/sandbox-contract/schemas/account-routes";
import { mayUse, type S2sAsker } from "../../s2s/askers.js";
import { type ContactRow, vouchedSandboxOf } from "../../s2s/contacts/contacts-store.js";
import { firstSettle, watchSettles } from "../../s2s/messages/first-settle.js";
import type { SendGuard } from "../../s2s/messages/send-guard.js";
import { sendMessage } from "../../s2s/messages/send-message.js";
import type { S2s } from "../../s2s/s2s-service.js";
import type { RouteTarget } from "../route-client.js";

/* A DROP SENT AS A MESSAGE (docs/architecture/account-routing.md, "A drop"; docs/architecture/messages.md, "Across
 * versions"): `sandboxes send` to a sandbox this one holds an accepted contact for, one that speaks s2s/1 (the person's own
 * route, a person-scoped contact; with no one person, the sandbox's own), goes as a `message`: the note its text, the
 * files its attachments, within the drops' limits, through the one outbox, under the owner's rules for an agent's send.
 * The contact is found by what someone other than the contact vouches for: the platform's answer for the name (asked as
 * the person, or as the owner for a send as no one person), or the exact vouched sandbox id or address the send names;
 * never by a name or a sandbox id the contact gave itself.
 * Without such a contact, or with `--wake`, the drop goes the old way (drop.routes.ts): a message starts and steers no
 * turn over there, only that sandbox's automations decide, so a drop asking to be said into a conversation is a drop. */

// How long the send waits for the message's first attempt, as long as the account door's own try.
const FIRST_TRY_MS = 15_000;

export interface DropAsMessageDeps {
    readonly s2s: Pick<S2s, "contacts" | "threads" | "outbox" | "core">;
    // The owner's rules on an agent's send (s2s/messages/send-guard.ts).
    readonly guard: SendGuard;
    // The platform's word on which sandbox a person means by a name, when it answers.
    readonly locate: (person: string, sandbox: string) => Promise<RouteTarget | undefined>;
    // Whom a send as no one person asks the platform as: the sandbox's owner.
    readonly owner: () => Promise<string | undefined>;
    readonly firstTryMs?: number;
}

// Whether a contact is the sandbox a send names: the platform's target for the name (its vouched id, or the address its key
// was confirmed at being where the platform says), or, with no answer, the exact vouched id or address the send names.
const isNamed = (row: ContactRow, zone: string | undefined, sandbox: string, target: RouteTarget | undefined): boolean => {
    const vouched = vouchedSandboxOf(row, zone);
    if (target !== undefined) {
        const host = normalizeAddress(target.address);
        return vouched === target.sandboxId || (host !== undefined && row.address === host);
    }
    return vouched === sandbox || row.address === normalizeAddress(sandbox);
};

/** The one contact a drop to `sandbox` goes over as `person` (or the sandbox itself), when there is one. */
const contactFor = async (deps: DropAsMessageDeps, person: string | undefined, sandbox: string): Promise<ContactRow | undefined> => {
    const scoped = (await deps.s2s.contacts.list()).filter(
        (row) =>
            row.state === "accepted" &&
            speaksS2s(row.document) &&
            (person === undefined ? row.scope.kind === "sandbox" : row.scope.kind === "person" && row.scope.person === person.toLowerCase()),
    );
    if (scoped.length === 0) {
        return undefined;
    }
    // The platform's word on which sandbox the person (or the owner, for a send as no one person) means by the name.
    const asking = person ?? (await deps.owner());
    const target = asking === undefined ? undefined : await deps.locate(asking, sandbox);
    const matches = scoped.filter((row) => isNamed(row, deps.s2s.core.deps.zone, sandbox, target));
    return matches.length === 1 ? matches[0] : undefined;
};

/** The drop as a message, or undefined when it goes the old way. `person` is the one the sending turn acts for, if one. */
export const dropAsMessage = async (deps: DropAsMessageDeps, asker: S2sAsker, person: string | undefined, ask: DropSend): Promise<DropSendOutcome | undefined> => {
    if (ask.wake !== undefined || asker.kind !== "turn") {
        return undefined;
    }
    const row = await contactFor(deps, person, ask.sandbox);
    if (row === undefined || !mayUse(asker, row.scope)) {
        return undefined;
    }
    const text = ask.note ?? "";
    const { guard, s2s } = deps;
    const held = await guard.refusal();
    if (held !== undefined) {
        guard.record(asker, row, text, held);
        return { state: "refused", reason: held };
    }
    watchSettles(s2s.outbox);
    const sent = await sendMessage({ contacts: s2s.contacts, threads: s2s.threads, outbox: s2s.outbox, now: Date.now }, asker, { to: row.id, text, files: ask.files });
    if ("error" in sent || sent.state !== "queued") {
        const reason = "error" in sent ? sent.error : sent.reason;
        guard.record(asker, row, text, reason);
        return { state: "refused", reason };
    }
    guard.record(asker, row, text, undefined);
    const name = row.name ?? row.document.name;
    const settled = await firstSettle(s2s.outbox, sent.id, deps.firstTryMs ?? FIRST_TRY_MS);
    if (settled?.state === "sent") {
        return { state: "delivered", to: name, id: sent.id };
    }
    if (settled?.state === "undelivered") {
        return { state: "refused", reason: `${name} did not take it: ${settled.reason}` };
    }
    const why = settled === undefined ? "it has not answered yet" : settled.reason;
    return { state: "queued", to: name, reason: `sent as a message in thread ${sent.thread} (\`messages show ${sent.thread}\`): ${why}`, times: 1 };
};
