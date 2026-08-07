// The cloud lane's shared vocabulary. Each provider adapter (hetzner.ts, digitalocean.ts, oracle.ts) is a
// standalone plain-fetch client — same stance as ../cloudflare.ts: the platform must not grow provider SDK
// dependencies, and the credential lives exactly as long as the request that carried it. index.ts is the
// provider switch the routes call.

// The pasted credential is wrong — invalid, expired, or missing a scope. The router maps this to BAD_REQUEST
// so the wizard tells the user to fix the paste (the CloudflareTokenError contract).
export class CloudCredentialError extends Error {}

// The provider understood us and said no, for a reason the USER can act on: server limit reached, a machine
// of that name already exists, no free-tier capacity right now. Also BAD_REQUEST — the message is written for
// the person at the wizard. Anything else (network, unexpected shape) propagates and maps to BAD_GATEWAY.
export class CloudProviderError extends Error {}

// What every adapter's create takes: the derived machine name, the user's region/size picks, and the
// first-boot script (user-data.ts). Image choice is the adapter's own (each provider names Ubuntu 24.04
// differently).
export interface CloudCreate {
    readonly name: string;
    readonly location: string;
    readonly size: string;
    readonly userData: string;
}
