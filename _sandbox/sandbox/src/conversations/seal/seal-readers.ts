import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { SEAL_OPEN_HOURS, type Seal, type SealAnswer, type SealSet } from "@intentic/sandbox-contract/schemas/seal";
import { ORPCError } from "@orpc/server";
import type { Caller } from "../../auth/auth.js";
import { holdsSeal, readVia } from "../../auth/seal-scope.js";
import { opt } from "../../opt.js";
import { areasCover } from "../../auth/fleet-scope.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { freshSeal, writeFamilySeal } from "./seal-family.js";
import { mayChange, personOf, same, type SealKit, sealOf } from "./seal-kit.js";

/* Who reads a private conversation, as its author changes it (seal.routes.ts): making it private or shared, naming its
 * readers, and answering someone who asked. */

const DAY_MS = SEAL_OPEN_HOURS * 60 * 60_000;

// The addresses named besides the author, each a member who holds the conversation's own areas, or the refusal.
const checkedReaders = async (kit: SealKit, root: PersistedAgent, emails: readonly string[]): Promise<void> => {
    const members = await kit.services.members.list();
    const ownerEmail = await kit.services.ownerEmail();
    // The same two tests a handover asks (ownership.ts): someone who can sign in here, holding the areas it works in.
    for (const email of emails) {
        const member = members.find((held) => same(held.email, email));
        if (member === undefined && (ownerEmail === undefined || !same(ownerEmail, email))) {
            throw new ORPCError("BAD_REQUEST", { message: `${email} is not a member of this sandbox` });
        }
        if (member !== undefined && !areasCover(member.areas, root.identity.areas)) {
            throw new ORPCError("BAD_REQUEST", { message: `this conversation works in parts of the workspace ${email} does not have access to` });
        }
    }
};

/** `seal.set`: private to its author and the people named, or shared again, for the whole family. */
export const setPrivate = async (kit: SealKit, caller: Caller, input: SealSet): Promise<AgentSummary> => {
    const root = kit.rootFor(input.id, caller);
    if (root.seal !== undefined && readVia(caller.email, root.seal, Date.now())?.via !== "reader") {
        throw new ORPCError("FORBIDDEN", { message: "only its readers may change who reads it" });
    }
    if (!mayChange(caller, root)) {
        throw new ORPCError("FORBIDDEN", { message: "only whoever answers for this conversation may make it private or shared" });
    }
    if (!input.private) {
        kit.record(caller, "seal.share", root.id);
        kit.replaceShells();
        return kit.framed(caller, await writeFamilySeal(kit.services, root.id, undefined));
    }
    if (root.seal === undefined && (await kit.bindingHouse()).mode === "everyone") {
        throw new ORPCError("FORBIDDEN", { message: "the house rule here keeps every conversation readable by everyone who can see it" });
    }
    const author = root.social.owner ?? personOf(caller);
    const named = input.readers ?? (root.seal?.readers ?? []).slice(1).map((reader) => reader.email);
    const others = [...new Set(named.map((email) => email.toLowerCase()))].filter((email) => !same(email, author.email));
    await checkedReaders(kit, root, others);
    const known = new Map((root.seal?.readers ?? []).map((reader) => [reader.email.toLowerCase(), reader]));
    const fresh = freshSeal(author, others.map((email) => known.get(email) ?? { email }), Date.now());
    const seal: Seal = root.seal === undefined ? fresh : { ...root.seal, readers: fresh.readers };
    kit.record(caller, root.seal === undefined ? "seal.make" : "seal.readers", root.id, { readers: seal.readers.length });
    kit.replaceShells();
    return kit.framed(caller, await writeFamilySeal(kit.services, root.id, seal));
};

/** `seal.ask`: the caller asks its author to show it to them; its author is told. */
export const askToRead = async (kit: SealKit, caller: Caller, id: string): Promise<AgentSummary> => {
    const root = kit.rootFor(id, caller);
    const seal = sealOf(root);
    if (readVia(caller.email, seal, Date.now()) !== undefined) {
        return kit.framed(caller, kit.services.agents.get(root.id));
    }
    const asks = [...(seal.asks ?? []).filter((ask) => !same(ask.email, caller.email)), { ...personOf(caller), at: Date.now() }];
    const summary = await kit.services.agents.setSeal(root.id, { ...seal, asks });
    const author = seal.readers[0];
    if (author !== undefined) {
        await kit.tell(author.email, `${caller.name ?? caller.email} asks to read a private conversation`, root.id, root.social.title?.text ?? "");
    }
    return kit.framed(caller, summary);
};

// The seal once an ask is answered: a reader for good, a grant for a day, or only the ask taken away.
const answeredSeal = (seal: Seal, ask: NonNullable<Seal["asks"]>[number], answer: SealAnswer["answer"], by: string): Seal => {
    const asks = (seal.asks ?? []).filter((held) => held !== ask);
    const person = { email: ask.email, ...opt("name", ask.name) };
    if (answer === "always") {
        return { ...seal, asks, readers: [...seal.readers, person] };
    }
    if (answer === "day") {
        return { ...seal, asks, grants: [...(seal.grants ?? []).filter((held) => !same(held.email, ask.email)), { ...person, until: Date.now() + DAY_MS, by }] };
    }
    return { ...seal, asks };
};

/** `seal.answer`: a reader shows it to whoever asked, for a day or for good, or says no. */
export const answerAsk = async (kit: SealKit, caller: Caller, input: SealAnswer): Promise<AgentSummary> => {
    const root = kit.rootFor(input.id, caller);
    const seal = sealOf(root);
    if (!holdsSeal(caller, seal)) {
        throw new ORPCError("FORBIDDEN", { message: "only its readers answer who asks to read it" });
    }
    const ask = seal.asks?.find((held) => same(held.email, input.email));
    if (ask === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "nobody by that address is waiting for an answer" });
    }
    const next = answeredSeal(seal, ask, input.answer, caller.email.toLowerCase());
    if (input.answer === "decline") {
        return kit.framed(caller, await kit.services.agents.setSeal(root.id, next));
    }
    kit.record(caller, "seal.show", root.id, { to: ask.email, for: input.answer });
    return kit.framed(caller, await writeFamilySeal(kit.services, root.id, next));
};
