import type { CertificateRequest, CertificateRequestInput } from "@intentic/sandbox-contract/schemas/certificate-request";
import type { DeviceSignInStart, DeviceSignInWait } from "@intentic/sandbox-contract/schemas/device-sign-in";
import type { McpAuthCheck, McpSignInStart, McpSignInWait } from "@intentic/sandbox-contract/schemas/mcp-sign-in";

// The sign-ins and key requests a capability form starts, answered with no provider behind them: a person pressing Sign
// in sees the code, the wait and the "Connected as" line the real daemon gives, and the token each answers installs
// nothing anywhere but the demo's own store. Each wait answers "waiting" once before it ends, so the form's waiting state
// is on screen for a moment, as it is against a provider.

const WAIT_MS = 1500;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let flows = 0;
const asked = new Set<string>();
const nextFlow = (kind: string): string => {
    flows += 1;
    return `${kind}-${flows}`;
};

// Waiting once, then done: the first wait for a flow holds a moment and says it is still waiting.
const settledAfterOneWait = async (flow: string): Promise<boolean> => {
    if (asked.has(flow)) {
        return true;
    }
    asked.add(flow);
    await pause(WAIT_MS);
    return false;
};

// A hosted MCP server (`mcp.<vendor>…`) asks for a sign-in, as Linear's, Sentry's and Atlassian's do; a local or
// self-hosted one takes a pasted token.
const hostOf = (url: string): string => URL.parse(url)?.hostname ?? ``;
const vendorOf = (host: string): string => {
    const name = host.replace(/^mcp\./, ``).split(`.`)[0] ?? host;
    return name.charAt(0).toUpperCase() + name.slice(1);
};

export const mcpAuthCheck = (url: string): McpAuthCheck => {
    const host = hostOf(url);
    if (host === ``) {
        return { auth: `unreachable`, detail: `That is not an address the sandbox can call.` };
    }
    return host.startsWith(`mcp.`)
        ? { auth: `oauth`, server: vendorOf(host), registers: true, redirectUri: `https://acme-shop.sbx.intentic.dev/oauth/mcp/callback` }
        : { auth: `token` };
};

const mcpServers = new Map<string, string>();

export const mcpSignInStart = (url: string): McpSignInStart => {
    const flow = nextFlow(`mcp`);
    const server = vendorOf(hostOf(url));
    mcpServers.set(flow, server);
    // The demo's own page stands in for the authorization server's consent page.
    return { flow, authorizeUrl: `${globalThis.location.origin}/demo/`, redirectUri: `https://acme-shop.sbx.intentic.dev/oauth/mcp/callback`, server };
};

export const mcpSignInWait = async (flow: string): Promise<McpSignInWait> => {
    const server = mcpServers.get(flow);
    if (server === undefined) {
        return { state: `failed`, message: `That sign-in lapsed. Press Sign in again.` };
    }
    if (!(await settledAfterOneWait(flow))) {
        return { state: `waiting` };
    }
    return { state: `done`, token: `mcpsession-${flow}`, server, account: `ada@acme.dev`, scope: `read write` };
};

export const deviceSignInStart = (): DeviceSignInStart => ({
    flow: nextFlow(`device`),
    userCode: `GH7K-2QXW`,
    verificationUri: `https://login.microsoft.com/device`,
    expiresIn: 900,
});

export const deviceSignInWait = async (flow: string): Promise<DeviceSignInWait> => {
    if (!(await settledAfterOneWait(flow))) {
        return { state: `waiting` };
    }
    return {
        state: `done`,
        token: `devicesession-${flow}`,
        who: `ada@acme.dev`,
        granted: [`Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `offline_access`],
        bound: [],
    };
};

// A request whose subject is what the form said, armored as an issuer expects; its body is filler, never a real key.
export const certificateRequest = (input: CertificateRequestInput): CertificateRequest => {
    // The form's answers by the e-Doręczenia card's field names; the real daemon reads the card's `keyRequest.subject`.
    const parts = [
        [`C`, `country`],
        [`ST`, `province`],
        [`L`, `locality`],
        [`O`, `organization`],
        [`OU`, `unit`],
        [`CN`, `commonName`],
    ] as const;
    const subject = parts
        .flatMap(([part, key]) => {
            const value = input.values[key] ?? input.values[part];
            return value === undefined || value === `` ? [] : [`${part}=${value}`];
        })
        .join(`, `);
    flows += 1;
    const body = btoa(`demo-csr-${flows}-${subject}`.padEnd(180, `.`)).match(/.{1,64}/g) ?? [];
    return {
        request: [`-----BEGIN CERTIFICATE REQUEST-----`, ...body, `-----END CERTIFICATE REQUEST-----`].join(`\n`),
        subject: subject === `` ? `CN=acme-shop` : subject,
        token: `keyrequest-${flows}`,
    };
};
