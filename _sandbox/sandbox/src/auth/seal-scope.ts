import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { Seal, SealAsk, SealGrant, SealOpen, SealPerson, SealVia, SealView } from "@intentic/sandbox-contract/schemas/seal";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { opt } from "../opt.js";
import type { Caller } from "./auth.js";

/* WHO READS A PRIVATE CONVERSATION (schemas/seal.ts), as one rule for every door: the board, every route that hands out a
 * conversation's words, the event stream, and a turn reading the fleet (scope/turn-reader.ts). Its readers, someone its
 * author let in for a day, and an opening without asking while it lasts. Nobody else, the sandbox owner and Full access
 * included: neither role reads past a seal, which is the whole of the promise. A program (a panel, a control token, an
 * agent with no proof of its turn) is nobody here.
 *
 * What everyone who may see the conversation at all is still shown is its sealed card (`sealedCard`): whose it is, where
 * it stands and its diff, since its work is shared even when its words are not. Never its title. */

// What of a seal the rule reads: the registry's own record and a summary's view both carry these.
// A summary's view may carry no readers at all (a sealed card names only its author), which reads as nobody.
export interface SealHold {
    readonly readers?: readonly SealPerson[] | undefined;
    readonly grants?: readonly SealGrant[] | undefined;
    readonly opens?: readonly SealOpen[] | undefined;
    readonly asks?: readonly SealAsk[] | undefined;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// An opening that lets its opener read: agreed to (or needing nobody's agreement), not refused, and still in its day.
const openFor = (email: string, seal: SealHold, now: number) =>
    seal.opens?.find((open) => same(open.email, email) && open.pending !== true && open.refusedBy === undefined && open.until > now);

/** How this person reads a sealed conversation now, or undefined when they may not. */
export const readVia = (email: string | undefined, seal: SealHold, now: number): { readonly via: SealVia; readonly until?: number } | undefined => {
    if (email === undefined || email === "") {
        return undefined;
    }
    if (seal.readers?.some((reader) => same(reader.email, email)) === true) {
        return { via: "reader" };
    }
    const grant = seal.grants?.find((held) => same(held.email, email) && held.until > now);
    if (grant !== undefined) {
        return { via: "grant", until: grant.until };
    }
    const open = openFor(email, seal, now);
    return open === undefined ? undefined : { via: "open", until: open.until };
};

/** Whether a seal keeps this caller out. A conversation with no seal keeps nobody out. */
export const sealedFrom = (caller: Pick<Caller, "email"> | undefined, seal: SealHold | undefined, now: number = Date.now()): boolean =>
    seal !== undefined && readVia(caller?.email, seal, now) === undefined;

/** Whether this caller is the seal's author or a reader they added: who may change it and answer who asks. */
export const holdsSeal = (caller: Pick<Caller, "email"> | undefined, seal: SealHold): boolean =>
    caller !== undefined && seal.readers?.some((reader) => same(reader.email, caller.email)) === true;

// The one opening waiting on a second person, if any.
export const pendingOpen = (seal: SealHold) => seal.opens?.find((open) => open.pending === true && open.refusedBy === undefined);

/** The seal as a summary carries it before it is framed for a caller: every list whole. */
export const sealHeld = (seal: Seal): SealView => ({
    readers: seal.readers,
    ...opt("grants", seal.grants),
    ...opt("asks", seal.asks),
    ...opt("opens", seal.opens),
});

/** A reader's view: everything, with how they read it. */
export const readerView = (summary: AgentSummary, via: { readonly via: SealVia; readonly until?: number }): AgentSummary =>
    summary.seal === undefined ? summary : { ...summary, seal: { ...summary.seal, via: via.via, ...opt("until", via.until) } };

// Nothing a sealed card waits on but a clash in its work: a question, a plan or a permission is the conversation's words.
const NO_ATTENTION: AgentSummary["attention"] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
    need: false,
};

// The fields a sealed card keeps. Everything else is the conversation's words or describes them (a title, a failure's
// sentence, the activity line, a queued message, a permission's ask, a checklist), so the allowlist is what keeps a field
// added later out of it: a new field is sealed until somebody decides it is work.
const SEALED_KEEPS = [
    "id",
    "status",
    "provider",
    "harness",
    "runner",
    "updatedAt",
    "answeredAt",
    "startedAt",
    "archivedAt",
    "branch",
    "branches",
    "base",
    "owner",
    "startedBy",
    "areas",
    "home",
    "fresh",
    "forkedFrom",
    "autoLand",
    "landRequested",
    "diff",
    "landedPresence",
    "conflictCauses",
    "awaitingWake",
] as const satisfies readonly (keyof AgentSummary)[];

const pick = (summary: AgentSummary): Partial<AgentSummary> =>
    Object.fromEntries(SEALED_KEEPS.filter((field) => summary[field] !== undefined).map((field) => [field, summary[field]]));

const asPerson = (person: SealPerson): SealPerson => ({ email: person.email, ...opt("name", person.name) });

/**
 * A sealed conversation as someone who may not read it sees it: whose it is, where it stands, its diff for whoever lands
 * it, and the one thing the caller can do about it. The owner may open it without asking; whoever could be the second
 * person sees the opening waiting on them, with its reason, since that is what they are asked to judge.
 */
export const sealedCard = (summary: AgentSummary, caller: Caller | undefined): AgentSummary => {
    const seal: SealHold = summary.seal ?? {};
    const pending = pendingOpen(seal);
    const opener = pending !== undefined && caller !== undefined && same(pending.email, caller.email);
    const approver = pending !== undefined && caller !== undefined && !opener && roleAtLeast(caller.role, "maintainer");
    const asked = caller !== undefined && seal.asks?.some((ask) => same(ask.email, caller.email)) === true;
    const view: SealView = { sealed: true };
    if (asked) {
        view.asked = true;
    }
    if (pending !== undefined && (opener || approver)) {
        view.pending = pending;
    }
    if (caller?.role === "owner" && pending === undefined) {
        view.canOpen = true;
    }
    if (approver) {
        view.canApprove = true;
    }
    // Whose it is, by the author's own name, so the card says who to ask.
    const author = seal.readers?.[0];
    if (author !== undefined) {
        view.readers = [asPerson(author)];
    }
    const attention = { ...NO_ATTENTION, conflict: summary.attention.conflict };
    return { ...pick(summary), id: summary.id, status: summary.status, provider: summary.provider, harness: summary.harness, updatedAt: summary.updatedAt, attention, seal: view };
};
