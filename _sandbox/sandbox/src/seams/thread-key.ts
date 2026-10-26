// One thread's key: namespaced by provider (no channel-id collisions), by automation (independent conversations per
// automation), and by the persona the sender's lane resolved to, so two people a channel answers as different agents
// never share a conversation or a session (automations/senders.ts). No persona is the bare key. A lane that runs as a
// service of its own adds it after the persona (`@service`), so two lanes acting for different services never share one
// either: a conversation acts for every service it latched (access/principal-chain.ts). The key of a
// sessions/thread-sessions.ts record, kept here since the doors that compute one (automations, the webchat outbox) sit
// on either side of the sessions store.
export const threadKey = (provider: string, automationId: string, channelId: string, persona?: string, service?: string): string => {
    const base = persona === undefined ? `${provider}:${automationId}:${channelId}` : `${provider}:${automationId}:${channelId}:${persona}`;
    return service === undefined ? base : `${base}@${service}`;
};
