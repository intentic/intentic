import { createHash, randomBytes } from "node:crypto";
import { CAPABILITY_KIND_TRAITS } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import { NO_TOOL_GRANTS, type ToolCallGrants, type ToolGrantAccount } from "@intentic/sandbox-contract/extension-protocol";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { TurnHolding } from "../../agent/tools/turn-mounts.js";
import { accountSites } from "../../browser/tools/accounts-tools.js";
import { contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";

/* WHAT AN EXTENSION'S TOOL CALL MAY DO WITH ITS TURN (2026-11-26, extension API 2.55.0). An extension's tools
   (`api.tools.serve`) are mounted into a turn the role granted them, and until now a call knew only its conversation: it
   could not tell which accounts the turn held, drive one of them, reach the owner's browser the turn held, or start a
   background job. Each call forwarded from the MCP door now carries the turn's grants (what the turn holds, read from
   its lease: the capabilities its role and its people's reach left it, and what it mounted) and a ticket: an opaque
   value the daemon minted for that extension and that call, alive only while the call is in flight. The extension's
   backend hands the ticket back to the turn doors (tool-turn-doors.ts) to drive the turn's own browser router, the
   owner's browser through its peer door, or to file a job, whose own ticket then carries the same grants for as long as
   the job runs. A ticket another extension presents, one past its call, and anything the grants do not name are refused
   at those doors, whatever the extension asks. */

// One ticket's worth of standing: whose call it is, in which conversation, what the turn held, and the turn itself while
// it runs (a job outlives it, and then reaches only what does not need it: the owner's browser).
export interface TurnTicket {
    // The extension's install id (the routing id the MCP door mounted it under, as its token names it).
    readonly extension: string;
    readonly conversationId: string | undefined;
    readonly grants: ToolCallGrants;
    readonly turn: TurnHolding | undefined;
    // A job's ticket names its job; a call's names none.
    readonly job?: string;
}

export interface TurnTickets {
    /** Mints a ticket for `standing`; answers it with its release, safe to call twice. */
    readonly mint: (standing: TurnTicket) => { readonly ticket: string; readonly release: () => void };
    /** The standing a live ticket was minted for, or undefined for one never minted, or released. */
    readonly read: (ticket: string) => TurnTicket | undefined;
}

// Keyed by the ticket's digest, as the turn's bearers are (turn-mounts.ts): a lookup compares no secret byte by byte.
const digestOf = (ticket: string): string => createHash("sha256").update(ticket).digest("hex");

export const createTurnTickets = (): TurnTickets => {
    const live = new Map<string, TurnTicket>();
    return {
        mint: (standing) => {
            const ticket = randomBytes(32).toString("base64url");
            const key = digestOf(ticket);
            live.set(key, standing);
            return { ticket, release: () => void live.delete(key) };
        },
        read: (ticket) => live.get(digestOf(ticket)),
    };
};

// allow(module-state): the tickets of this daemon's calls and jobs in flight, which end with the process.
export const turnTickets: TurnTickets = createTurnTickets();

export type ToolGrantsDeps = Pick<Services, "capabilities"> & Partial<Pick<Services, "accountSignInUrls">> & ExtensionHost;

// An account the turn holds, with the sites it signs in on (its sign-in pages' hosts, widened to the operator's sign-in
// family), the same sites `type_credential` holds a page to. None on record leaves it no site to be driven on.
const accountOf = async (deps: ToolGrantsDeps, capability: Capability): Promise<ToolGrantAccount | undefined> => {
    if (capability.kind !== "browser" && capability.kind !== "identity") {
        return undefined;
    }
    const urls = await (deps.accountSignInUrls?.(capability) ?? Promise.resolve([]))
        // allow(silent-catch): a card whose extension is gone names no site, and an account with none is driven nowhere.
        .catch((): readonly string[] => []);
    return { id: capability.id, kind: capability.kind, sites: accountSites(urls) };
};

/**
 * What a call of `extension`'s tools is told its turn holds: every sandbox browser account (browser cards and
 * identities) the turn was granted, the owner's own browsers it mounted, and the cards of the extension's own kinds it
 * was granted. Nothing for a call with no turn behind it.
 */
export const toolGrantsOf = async (deps: ToolGrantsDeps, extension: string, turn: TurnHolding | undefined): Promise<ToolCallGrants> => {
    if (turn === undefined) {
        return NO_TOOL_GRANTS;
    }
    const held = (await Promise.all(turn.granted.map((id) => deps.capabilities.get(id)))).filter((capability): capability is Capability => capability !== undefined);
    const accounts = (await Promise.all(held.filter((capability) => CAPABILITY_KIND_TRAITS[capability.kind].sandboxBrowser).map((capability) => accountOf(deps, capability)))).filter(
        (account): account is ToolGrantAccount => account !== undefined,
    );
    const heldIds = new Set(held.map((capability) => capability.id));
    const browsers = [...turn.mounted().values()].flatMap((target) => (target.kind === "webext" && heldIds.has(target.id) ? [target.id] : []));
    const registry = await contributionRegistry(deps);
    const cards = held.filter((capability) => contributionFor(registry, capability.kind, capability.config)?.extension.id === extension).map((capability) => capability.id);
    return { accounts, browsers: [...new Set(browsers)], cards };
};
