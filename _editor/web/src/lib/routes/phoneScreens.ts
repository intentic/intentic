import { legacyPathOf } from "@intentic/sandbox-contract/app-routes";
import { here, linkOf, page, type RouteRead } from "./links";

// The phone's screen geometry as pure rules, importable by the router and the shell without the composables' graph.
// Each address is the frame and sandbox the reader is in (links.ts `here`), unless a route is named for it.

/**
 * A sandbox's board on a phone, in the form addresses had before frames: what the Android app's bridge reads
 * (router/nativeHandoff.ts). A link to the board is `here(page.agents())`. The app's own first screen is Home's list of
 * sandboxes (lib/routes/firstScreens.ts), except in the Android app, which draws this board.
 */
export const PHONE_HOME = legacyPathOf(page.agents());

/** The phone's chat surface for a conversation: the agent's page, since a conversation is its own screen there. */
export const mobileChatPath = (conversationId: string, route?: RouteRead): string => here(page.agent(conversationId), route);

/** The query key naming which of an agent's two phone pages its route opens on, and the one value it reads. */
export const AGENT_VIEW = `view`;
export const CHANGES_VIEW = `changes`;

/** An agent's Changes alone: the agent's page opened on its review rather than its chat (AgentDetail). */
export const agentChangesPath = (conversationId: string): string => here(page.agent(conversationId, { query: { [AGENT_VIEW]: CHANGES_VIEW } }));

/** One page an agent showed in its conversation, full screen (ChatPageScreen), by the page's own id. */
export const agentPagePath = (conversationId: string, pageId: string): string => here(page.agentPage(conversationId, pageId));

/** The board, or a conversation under it: home needs no way back, and a conversation's screen draws its own arrow to
 *  the board. Every other screen a phone opens gets the shell's. Either form of address. */
export const ownsWayBack = (path: string): boolean => {
    const shown = linkOf(path)?.page;
    return shown === `agents` || shown === `agent` || shown === `agentPage`;
};
