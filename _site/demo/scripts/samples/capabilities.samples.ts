import type { GroupSamples } from "./context.ts";

// An agent connection is added (its apply streamed), re-checked, tested, signed in to, renamed and removed again, so the list ends
// as it began; the recommendation dismissed is the fixture's own.
export const capabilitiesSamples: GroupSamples<`capabilities`> = () => ({
    list: undefined,
    add: { id: `smoke-agent`, kind: `agent`, config: { command: `pi --rpc`, loginCommand: `pi login` } },
    status: { id: `smoke-agent` },
    probe: { id: `stripe`, kind: `cli`, config: { provider: `stripe`, apiKey: `VAULTED` } },
    sshKey: undefined,
    login: { id: `smoke-agent` },
    rename: { id: `smoke-agent`, to: `smoke-agent-renamed` },
    remove: { id: `smoke-agent-renamed` },
    setSecret: { id: `stripe`, value: `sk_live_demo` },
    marketplace: { url: `https://github.com/acme/registry` },
    refs: { url: `https://github.com/acme/registry` },
    dismiss: { entry: `cloudflare` },
    // A form's own sign-ins and key request (connectionSignIns.ts). Each wait names a flow its start may not have made in
    // this run; lapsed and still waiting are both answers the schema reads.
    mcpAuth: { url: `https://mcp.linear.app/mcp` },
    mcpSignIn: { url: `https://mcp.linear.app/mcp` },
    mcpSignInWait: { flow: `mcp-1` },
    deviceSignIn: { id: `microsoft365`, kind: `cli`, config: { provider: `microsoft365` } },
    deviceSignInWait: { flow: `device-1` },
    certificateRequest: { kind: `cli`, provider: `e-doreczenia`, field: `privateKey`, values: { organization: `Acme`, commonName: `acme-shop`, country: `PL` } },
});
