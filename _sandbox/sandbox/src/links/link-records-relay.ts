import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DiagnosticsQuery } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { liveTurnConversations, soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { type LinkRecordsBody, linkRecordsDiagnostics, linkRecordsRead, type LinkTarget } from "../sandboxes/link-client.js";
import { provesOwner } from "../seams/workload-stamp.js";

// THE ASKING SIDE OF A LINK'S RECORDS: this sandbox's agent reading another of the owner's sandboxes' conversations, logs
// and diagnostics with `--on <link>` (`agents ls|find|show|bundle`, `diagnostics`) or its link's tool server
// (link-mounts.ts). Nothing here decides what may be read over there: that sandbox's link terms do (link-records.ts).
// What is decided here is which turn may use which card, the same rule a delegated task is held to: the cards the turn
// was granted, so a persona that leaves a link out leaves its records out too.

type LinkCard = Extract<Capability, { kind: "link" }>;

export type LinkReach =
    | { readonly ok: true; readonly target: LinkTarget; readonly sandbox: string }
    | { readonly ok: false; readonly status: 403 | 404; readonly message: string };

export type LinkReachDeps = Pick<Services, "capabilities" | "conversations">;

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
        return roleAtLeast(identity.role, "maintainer")
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
            message: `This conversation's turn was not given the "${card.id}" link: its persona or the people it works for leave it out.`,
        };
    }
    return { ok: true, target: { id: card.id, config: card.config }, sandbox: card.config.name ?? card.id };
};

// What a far refusal says, in the `message` the agent's commands read: the link doors word theirs as `error`.
const relayedBody = (body: LinkRecordsBody, status: number): LinkRecordsBody =>
    status < 400 || body.message !== undefined ? body : { ok: false, message: body.error ?? `it answered ${status}` };

// A JSON answer at any status the far side gave, which Hono's typed `c.json` will not take as a plain number.
const json = (body: LinkRecordsBody, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const unreachable = (sandbox: string, message: string) => ({ ok: false, message: `"${sandbox}" did not answer: ${message}.` });

/** A fleet read (`GET /fleet…?on=<link>`), asked of the linked sandbox and answered as it answered. */
export const relayFleetRead = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string): Promise<Response> => {
    const reach = await linkReach(deps, c, name);
    if (!reach.ok) {
        return json({ ok: false, message: reach.message }, reach.status);
    }
    const url = new URL(c.req.url);
    url.searchParams.delete("on");
    const query = url.searchParams.toString();
    const read = await linkRecordsRead(reach.target, `/link/records${url.pathname}${query === "" ? "" : `?${query}`}`);
    return read.ok ? json(relayedBody(read.body, read.status), read.status) : json(unreachable(reach.sandbox, read.message), 502);
};

/** A diagnostics query (`diagnostics … --on <link>`), asked of the linked sandbox. */
export const relayDiagnostics = async (deps: LinkReachDeps, c: Context<AppEnv>, name: string, query: DiagnosticsQuery): Promise<Response> => {
    const reach = await linkReach(deps, c, name);
    if (!reach.ok) {
        return json({ ok: false, message: reach.message }, reach.status);
    }
    const answer = await linkRecordsDiagnostics(reach.target, query);
    if (answer.ok) {
        return json({ ...answer.value, sandbox: reach.sandbox }, 200);
    }
    return answer.status === 0
        ? json(unreachable(reach.sandbox, answer.message), 502)
        : json({ ok: false, message: `"${reach.sandbox}": ${answer.message}` }, answer.status);
};
