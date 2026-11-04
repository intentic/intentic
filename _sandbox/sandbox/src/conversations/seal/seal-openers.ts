import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { SealApprove, SealOpenCeremony } from "@intentic/sandbox-contract/schemas/seal";
import type { SealOpenProof } from "@intentic/sandbox-contract/schemas/seal-proof";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { Caller } from "../../auth/auth.js";
import { pendingOpen, readVia } from "../../auth/seal-scope.js";
import { opt } from "../../opt.js";
import { writeFamilySeal } from "./seal-family.js";
import { same, type SealKit, sealOf } from "./seal-kit.js";
import { answeredOpen, type SealOpenings, withOpen } from "./seal-open.js";

/* Opening a private conversation without asking, as the routes take it (seal.routes.ts; the passkey half is
 * seal-open.ts): the sandbox owner alone asks, its author is told at once, and where an organisation asks for two people a
 * second person with Full access agrees before anything can be read. Every step leaves an audit line. */

const ownerOnly = (caller: Caller): void => {
    if (caller.role !== "owner") {
        throw new ORPCError("FORBIDDEN", { message: "only the sandbox's owner may open a private conversation without asking" });
    }
};

/** `seal.prepareOpen`: the document the owner's passkey signs. */
export const prepareOpen = async (kit: SealKit, openings: SealOpenings, caller: Caller, input: { readonly id: string; readonly reason: string }, origin: string | undefined): Promise<SealOpenCeremony> => {
    ownerOnly(caller);
    const root = kit.rootFor(input.id, caller);
    const seal = sealOf(root);
    if (readVia(caller.email, seal, Date.now()) !== undefined || pendingOpen(seal) !== undefined) {
        throw new ORPCError("CONFLICT", { message: "you can already read it, or an opening already waits on a second person" });
    }
    return await openings.prepare(root.id, input.reason, origin);
};

/** `seal.open`: the signed opening, recorded on the conversation for good and told to its author. */
export const openWithoutAsking = async (kit: SealKit, openings: SealOpenings, caller: Caller, input: SealOpenProof, origin: string | undefined): Promise<AgentSummary> => {
    ownerOnly(caller);
    const root = kit.rootFor(input.id, caller);
    const seal = sealOf(root);
    const open = await openings.verify(caller, { ...input, id: root.id }, origin, (await kit.bindingHouse()).twoPerson);
    const summary = await writeFamilySeal(kit.services, root.id, withOpen(seal, open));
    kit.record(caller, "conversation.unseal", root.id, { reason: open.reason, until: open.until, ...opt("pending", open.pending) });
    const who = caller.name ?? caller.email;
    const author = seal.readers[0];
    if (author !== undefined) {
        const said = open.pending === true ? `${who} asked to open your private conversation without asking` : `${who} opened your private conversation without asking`;
        await kit.tell(author.email, said, root.id, open.reason);
    }
    if (open.pending === true) {
        for (const member of (await kit.services.members.list()).filter((held) => roleAtLeast(held.role, "maintainer"))) {
            await kit.tell(member.email, `${who} asks you to agree to opening a private conversation`, root.id, open.reason);
        }
    }
    return kit.framed(caller, summary);
};

/** `seal.approveOpen`: the second person's yes or no. Never the owner who asked, nor the owner at all. */
export const approveOpen = async (kit: SealKit, caller: Caller, input: SealApprove): Promise<AgentSummary> => {
    const root = kit.rootFor(input.id, caller);
    const seal = sealOf(root);
    const open = seal.opens?.find((held) => held.id === input.open && held.pending === true && held.refusedBy === undefined);
    if (open === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "no opening of that id waits on a second person" });
    }
    if (same(open.email, caller.email) || caller.role === "owner") {
        throw new ORPCError("FORBIDDEN", { message: "the second person must be someone other than the owner who asked" });
    }
    const answered = answeredOpen(open, caller, input.agree, Date.now());
    const summary = await writeFamilySeal(kit.services, root.id, withOpen(seal, answered));
    kit.record(caller, input.agree ? "conversation.unseal.approve" : "conversation.unseal.refuse", root.id, { open: open.id });
    const author = seal.readers[0];
    if (author !== undefined && input.agree) {
        await kit.tell(author.email, `${open.name ?? open.email} opened your private conversation without asking`, root.id, open.reason);
    }
    await kit.tell(open.email, input.agree ? "Your opening was agreed to" : "Your opening was refused", root.id, open.reason);
    return kit.framed(caller, summary);
};
