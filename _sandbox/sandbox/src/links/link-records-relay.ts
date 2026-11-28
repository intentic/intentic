import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DiagnosticsQuery } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { liveTurnConversations, soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { type LinkRecordsBody, linkRecordsDiagnostics, linkRecordsRead, type LinkTarget } from "../sandboxes/link-client.js";
import { provesOwner } from "../seams/workload-stamp.js";
import { opt } from "../opt.js";
import { askerOf, mayUse, type S2sAsker, turnAskerOf } from "../s2s/askers.js";
import { contactServerName } from "../s2s/contacts/contact-mounts.js";
import type { ContactRow } from "../s2s/contacts/contacts-store.js";
import { askerDepsOf } from "../s2s/s2s-wiring.js";
import { z } from "zod";
import { routedDiagnostics, routedFleetRead, type RoutedReadDeps } from "./account-records-relay.js";

// THE ASKING SIDE OF A LINK'S RECORDS: this sandbox's agent reading another of the owner's sandboxes' conversations, logs
// and diagnostics with `--on <link>` (`agents ls|find|show|bundle`, `diagnostics`) or its link's tool server
// (link-mounts.ts). A contact by that name is asked first, by call (below). Nothing here decides what may be read over there: that sandbox's link terms do (link-records.ts).
// What is decided here is which turn may use which card, the same rule a delegated task is held to: the cards the turn
// was granted, so a role that leaves a link out leaves its records out too.

type LinkCard = Extract<Capability, { kind: "link" }>;

export type LinkReach =
    | { readonly ok: true; readonly target: LinkTarget; readonly sandbox: string }
    | { readonly ok: false; readonly status: 403 | 404; readonly message: string };

export type LinkReachDeps = Pick<Services, "capabilities" | "conversations" | "s2s" | "members"> & RoutedReadDeps;

const readableCard = (capability: Capability): capability is LinkCard => capability.kind === "link";

// The turn a shell call is for: the one it names with its proof, else the one turn in flight.
const askingTurn = (deps: LinkReachDeps, c: Context<AppEnv>): string | undefined => {
    const named = c.req.header("x-intentic-conversation");
    if (named !== undefined && named !== "" && provesOwner(named, c.req.header("x-intentic-turn-proof"))) {
        return named;
    }
    return soleLiveConversation(deps.conversations);
};

/** The link card a records read may go through for this caller, or why not. */
const linkReach = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string): Promise<LinkReach> => {
    const cards = (await deps.capabilities.list()).filter(readableCard);
    const card = cards.find((candidate) => candidate.id === name);
    if (card === undefined) {
        return {
            ok: false,
            status: 404,
            message:
                cards.length === 0
                    ? 'This sandbox is linked to no other sandbox. Linking one is the owner\'s: `capabilities request link --why "…"`.'
                    : `No linked sandbox is called "${name}". Linked here: ${cards.map((entry) => entry.id).join(", ")}.`,
        };
    }
    const identity = c.get("identity");
    if (identity !== undefined) {
        // A person: another sandbox's records are read at the floor this one's logs are.
        return tierAtLeast(identity.tier, "maintainer")
            ? { ok: true, target: { id: card.id, config: card.config }, sandbox: card.config.name ?? card.id }
            : { ok: false, status: 403, message: "Reading a linked sandbox's records is for this sandbox's owner and its maintainers." };
    }
    const turn = askingTurn(deps, c);
    if (turn === undefined && liveTurnConversations(deps.conversations).length > 0) {
        return {
            ok: false,
            status: 403,
            message: "Several turns are running and this shell names none of them: run it from a turn's own shell, which carries that turn's stamp.",
        };
    }
    const standing = turn === undefined ? undefined : turnStandingOf(deps.conversations, turn);
    if (standing !== undefined && !standing.granted.includes(card.id)) {
        return {
            ok: false,
            status: 403,
            message: `This conversation's turn was not given the "${card.id}" link: its role or the people it works for leave it out.`,
        };
    }
    return { ok: true, target: { id: card.id, config: card.config }, sandbox: card.config.name ?? card.id };
};

// No link card has that name: a turn reads it as its person instead, a sandbox they are in (account-records-relay.ts). A
// person signed in here reads only through a link: their own editor reads the other sandbox as them directly.
const routesAsPerson = (c: Context<AppEnv>, reach: Extract<LinkReach, { ok: false }>): boolean =>
    reach.status === 404 && c.get("identity") === undefined;

// What a far refusal says, in the `message` the agent's commands read: the link doors word theirs as `error`.
const relayedBody = (body: LinkRecordsBody, status: number): LinkRecordsBody =>
    status < 400 || body.message !== undefined ? body : { ok: false, message: body.error ?? `it answered ${status}` };

// A JSON answer at any status the far side gave, which Hono's typed `c.json` will not take as a plain number.
const json = (body: LinkRecordsBody, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const unreachable = (sandbox: string, message: string) => ({ ok: false, message: `"${sandbox}" did not answer: ${message}.` });

// A CONTACT FIRST (2026-11-27, docs/architecture/messages.md "Calls"): `--on <name>` names a contact this caller may use
// (by its id, its address, or a name only it and no link card answers to) before a link card or a person route, and the read goes
// as a `records.*` call over the contact's session. Who may use which is the contacts' rule (s2s/askers.ts): a
// sandbox-scoped contact for a maintainer or a turn acting for one, a person-scoped one for that person and their turns.
// The far side decides what may be read (its `records` grant, and a person's floor there).
const askerFor = async (deps: LinkReachDeps, c: Context<AppEnv>): Promise<S2sAsker> => {
    const askers = askerDepsOf(deps);
    if (c.get("identity") !== undefined) {
        return askerOf(askers, c);
    }
    const turn = askingTurn(deps, c);
    if (turn !== undefined) {
        return turnAskerOf(askers, turn);
    }
    // A shell naming no turn while none runs is the owner's own, as a link's read takes it (linkReach above).
    const owner = await deps.ownerEmail();
    return owner !== undefined && liveTurnConversations(deps.conversations).length === 0 ? { kind: "person", email: owner.toLowerCase(), maintainer: true } : { kind: "nobody" };
};

// The contacts `name` names: exactly by id or address; by a bare name (its name, its server's) only while one sandbox (one
// key) answers to it and no link card does, so a contact never names itself into a card's or another contact's place
// (2026-11-28): such a name reads the card, or nothing.
const contactsNamed = async (deps: LinkReachDeps, name: string): Promise<readonly ContactRow[]> => {
    const wanted = name.trim().toLowerCase();
    const accepted = (await deps.s2s.contacts.list()).filter((row) => row.state === "accepted");
    const exact = accepted.filter((row) => row.id === name.trim() || row.address === wanted);
    if (exact.length > 0) {
        return exact;
    }
    const named = accepted.filter((row) => (row.name ?? row.document.name).toLowerCase() === wanted || contactServerName(row) === wanted);
    const keys = new Set(named.map((row) => row.document.fingerprint));
    const card = (await deps.capabilities.list()).some((capability) => readableCard(capability) && capability.id.toLowerCase() === wanted);
    return keys.size === 1 && !card ? named : [];
};

const contactNamed = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string): Promise<ContactRow | undefined> => {
    const named = await contactsNamed(deps, name);
    // Who asks is read only when a contact goes by that name: with none, the read is a link's or a person route's as before.
    const asker = named.length === 0 ? undefined : await askerFor(deps, c);
    const usable = asker === undefined ? [] : named.filter((row) => mayUse(asker, row.scope));
    return usable.find((row) => row.scope.kind === "sandbox") ?? usable[0];
};

// A far fleet answer or refusal, kept whole: only the words a refusal carries are read here, as the link doors' are.
const FarBodySchema = z.looseObject({ error: z.string().optional(), message: z.string().optional() });

// A call's refusal as the agent's commands read it: the far side's own body where it sent one (an unknown handle, an
// ambiguous one with its candidates), else its words; no answer at all is a 502.
const calledBody = (row: ContactRow, failed: { readonly status: number; readonly message: string; readonly body?: unknown }): Response => {
    const sandbox = row.name ?? row.document.name;
    if (failed.status === 0) {
        return json(unreachable(sandbox, failed.message), 502);
    }
    const far = FarBodySchema.safeParse(failed.body).data;
    return far?.message === undefined ? json({ ok: false, message: `"${sandbox}": ${failed.message}` }, failed.status) : json(far, failed.status);
};

// A fleet read's path after `/fleet` as the call that asks it: the roster or a search, one conversation, or its bundle.
const fleetCall = async (deps: LinkReachDeps, c: Context<AppEnv>, row: ContactRow): Promise<Response> => {
    const url = new URL(c.req.url);
    url.searchParams.delete("on");
    const { q, ...query } = Object.fromEntries(url.searchParams);
    const [handle, rest] = url.pathname
        .replace(/^\/fleet/u, "")
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => decodeURIComponent(segment));
    const { client } = deps.s2s.calls;
    const answer =
        handle === undefined
            ? await client.call(row, "records.fleet", { ...opt("q", q), query })
            : rest === "bundle"
              ? await client.call(row, "records.bundle", { handle })
              : await client.call(row, "records.show", { handle, query });
    return answer.ok ? json(FarBodySchema.safeParse(answer.value).data ?? {}, 200) : calledBody(row, answer);
};


/** A fleet read (`GET /fleet…?on=<name>`), asked of the contact or the linked sandbox and answered as it answered. */
export const relayFleetRead = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string): Promise<Response> => {
    const contact = await contactNamed(deps, c, name);
    if (contact !== undefined) {
        return fleetCall(deps, c, contact);
    }
    const reach = await linkReach(deps, c, name);
    if (!reach.ok) {
        return routesAsPerson(c, reach)
            ? routedFleetRead(deps, c, { sandbox: name, unlinked: reach.message })
            : json({ ok: false, message: reach.message }, reach.status);
    }
    const url = new URL(c.req.url);
    url.searchParams.delete("on");
    const query = url.searchParams.toString();
    const read = await linkRecordsRead(reach.target, `/link/records${url.pathname}${query === "" ? "" : `?${query}`}`);
    return read.ok ? json(relayedBody(read.body, read.status), read.status) : json(unreachable(reach.sandbox, read.message), 502);
};

/** A diagnostics query (`diagnostics … --on <name>`), asked of the contact or the linked sandbox. */
export const relayDiagnostics = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string, query: DiagnosticsQuery): Promise<Response> => {
    const contact = await contactNamed(deps, c, name);
    if (contact !== undefined) {
        const answer = await deps.s2s.calls.client.call(contact, "records.diagnostics", query);
        return answer.ok ? json({ ...answer.value, sandbox: contact.name ?? contact.document.name }, 200) : calledBody(contact, answer);
    }
    const reach = await linkReach(deps, c, name);
    if (!reach.ok) {
        return routesAsPerson(c, reach)
            ? routedDiagnostics(deps, c, { sandbox: name, unlinked: reach.message }, query)
            : json({ ok: false, message: reach.message }, reach.status);
    }
    const answer = await linkRecordsDiagnostics(reach.target, query);
    if (answer.ok) {
        return json({ ...answer.value, sandbox: reach.sandbox }, 200);
    }
    return answer.status === 0
        ? json(unreachable(reach.sandbox, answer.message), 502)
        : json({ ok: false, message: `"${reach.sandbox}": ${answer.message}` }, answer.status);
};
