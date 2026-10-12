// The caller's address, for rate keys and Turnstile's optional remoteip check. Behind the tunnel the socket is
// Cloudflare's, so only the forwarded header carries the visitor's: advisory either way, never an identity.
export const remoteIpOf = (c: { readonly req: { header: (name: string) => string | undefined } }): string | undefined =>
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
