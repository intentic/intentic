// Where a routed loop sends a provider's model requests: the daemon's translator gateway on its own loopback address
// (agent/providers/translator-gateway.ts), under a session signed for that provider, which places each request on one
// account before the translator sees it. A module of its own that imports nothing, so a door lending the translator
// (sandboxes/credential-lending.ts) can know the gateway's address without reaching up into the agent.
export const TRANSLATOR_GATEWAY_PATH = "/translator-gateway";

/** Whether a base URL is the gateway's, under any session. */
export const isTranslatorGatewayUrl = (url: string): boolean => /^http:\/\/127\.0\.0\.1:\d+\/translator-gateway\/[^/]+/u.test(url);
