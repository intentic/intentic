// The header names the daemon, the platform, `ic` and extensions agree on, each spelled once.

// Correlates a browser call to the daemon request that served it; a token only, never a security boundary.
export const REQUEST_ID_HEADER = "x-intentic-request-id";

// The header a sandbox's connect token travels in: the platform's routes a sandbox calls as itself
// (api-contract's PLATFORM_INGRESS), the daemon's own gate, which takes the token from `ic` and the owner's browser,
// and its `/enroll`. `ic` spells it in Rust; api-contract's ingress test holds that spelling to this value.
export const CONNECT_TOKEN_HEADER = "x-intentic-connect";

// The header an extension's backend and its processes present their per-extension token in, checked against the
// manifest's `permissions.daemon` (the daemon's auth/grants.ts). Declared here so the daemon's grant, the backend host
// that proxies to it and the connector runtime's daemon client spell it once.
export const EXTENSION_TOKEN_HEADER = "x-intentic-extension";
