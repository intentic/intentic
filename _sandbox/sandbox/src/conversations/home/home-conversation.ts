import { homeConversationId, isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { HomeConversation } from "@intentic/sandbox-contract/schemas/agents-list";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { landsHereFor } from "../../auth/operator.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

// A PERSON'S HOME CONVERSATION: the one long-running chat the master view opens on this sandbox, one per member
// (ids/conversation-ids.ts homeConversationId). It is an orchestrator by design: it spawns subagents, judges their work
// with review and test sessions, merges what it accepts (its children's work is held for it, land-target.ts), and lands
// and commits by itself when its turn ends, so its owner never reviews anything. What that rests on, kept here:
//
// - Whose it is comes from the verified caller, never from a body. The id is derived from the email, so a client may
//   compute it, but only its owner may speak into it; the sandbox's owner may read it (auth/fleet-scope.ts visibleTo).
// - Its opening latches `home` (agents-store.ts Identity). Whether its work lands by itself is its owner's own authority to
//   land (sandbox-contract `landsHere`), read again at every land (`homeOwnerLands`), so a re-grade moves the next land
//   rather than the one after a new home: the authority it gets is its owner's, never more and never staler. A
//   collaborator's home asks a maintainer; a home-only member's lands by itself exactly when they may land it.
// - A home-only member (`agents: "home"`) has nothing else here: every conversation they write into is their home
//   (`refuseUnlessHome`), so they start nothing of their own and land nobody else's work.
// - It works in a checkout of its own, where accepted work gathers before it lands: the shared tree has nothing to land.

// The loopback owner (no auth configured) holds the whole sandbox and has no email to derive an id from.
const LOOPBACK_OWNER = "owner@loopback";

const NOT_A_PERSON = "A home conversation is a person's: sign in as a member to open yours.";
const NOT_YOURS = "That is not your home conversation: every member has their own, and only its owner speaks into it.";
const ONLY_HOME = "Your access here is your home conversation: speak to it, and it starts and lands the rest.";
const NOT_ISOLATED =
    "A home conversation works in a copy of its own, where the work its subagents finish gathers before it lands: open it with `isolated`.";

type Caller = Pick<OrpcContext, "identity">;

// The caller's home conversation id, or the refusal: only a verified person, or the loopback owner, has one.
const homeIdOf = (services: Pick<Services, "auth">, context: Caller): string => {
    const email = context.identity?.email ?? (services.auth === undefined ? LOOPBACK_OWNER : undefined);
    if (email === undefined) {
        throw new ORPCError("FORBIDDEN", { message: NOT_A_PERSON });
    }
    return homeConversationId(email);
};

/** What a POST /agent turn adds when it speaks into a home conversation; nothing for any other conversation. */
export interface HomeOpening {
    readonly home?: true;
    readonly conversationAutoLand?: boolean;
}

/**
 * Refuses a turn into somebody else's home conversation, or one opening it on the shared tree, and says what the turn
 * that opens the caller's own latches: that it is a home, and, for an owner who may merge here, that its work lands.
 */
export const homeOpening = (
    services: Pick<Services, "auth" | "agents">,
    context: Caller,
    turn: { readonly conversationId: string; readonly isolated?: boolean | undefined },
): HomeOpening => {
    if (!isHomeConversationId(turn.conversationId)) {
        return {};
    }
    if (turn.conversationId !== homeIdOf(services, context)) {
        throw new ORPCError("FORBIDDEN", { message: NOT_YOURS });
    }
    if (services.agents.entry(turn.conversationId) !== undefined) {
        return {};
    }
    if (turn.isolated !== true) {
        throw new ORPCError("BAD_REQUEST", { message: NOT_ISOLATED });
    }
    return { home: true, ...opt("conversationAutoLand", landsHereFor(services, context) ? true : undefined) };
};

/**
 * Refuses a home-only member (members.ts `agents: "home"`) any conversation but their own home: the one door every route
 * that writes into, starts, or lands a conversation asks before acting. Nothing for anyone else.
 */
export const refuseUnlessHome = (services: Pick<Services, "auth">, context: Caller, conversationId: string | undefined): void => {
    if (context.identity?.agents === "home" && conversationId !== homeIdOf(services, context)) {
        throw new ORPCError("FORBIDDEN", { message: ONLY_HOME });
    }
};


/** `GET /agents/home`: the caller's home conversation id, its card once a turn opened it, and where its work goes. */
export const homeConversationOf = (services: Pick<Services, "auth" | "agents">, context: Caller): HomeConversation => {
    const conversationId = homeIdOf(services, context);
    const agent = services.agents.list().find((summary) => summary.id === conversationId);
    return { conversationId, ...opt("agent", agent), lands: landsHereFor(services, context) ? "itself" : "asks" };
};
