// The phone's screen geometry as pure rules, importable by the router and the shell without the composables' graph.

/** Home on a phone: the board, with the rail down its left (shell/MobileRail.vue). */
export const PHONE_HOME = `/agents`;

/** The phone's chat surface for a conversation: the agent route, since a conversation is its own screen there. */
export const mobileChatPath = (conversationId: string): string => `${PHONE_HOME}/${encodeURIComponent(conversationId)}`;

/** The query key naming which of an agent's two phone pages its route opens on, and the one value it reads. */
export const AGENT_VIEW = `view`;
export const CHANGES_VIEW = `changes`;

/** An agent's Changes alone: the agent route opened on its review rather than its chat (AgentDetail). */
export const agentChangesPath = (conversationId: string): string => `${mobileChatPath(conversationId)}?${AGENT_VIEW}=${CHANGES_VIEW}`;

/** One page an agent showed in its conversation, full screen (ChatPageScreen), by the page's own id. */
export const agentPagePath = (conversationId: string, pageId: string): string =>
    `${mobileChatPath(conversationId)}/pages/${encodeURIComponent(pageId)}`;

/** The board, or a conversation under it: home needs no way back, and a conversation's screen draws its own arrow to
 *  the board. Every other screen a phone opens gets the shell's. */
export const ownsWayBack = (path: string): boolean => path === PHONE_HOME || path.startsWith(`${PHONE_HOME}/`);
