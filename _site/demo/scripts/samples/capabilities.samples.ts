import type { GroupSamples } from "./context.ts";

// An agent connection is added (its apply streamed), tested, signed in to, renamed and removed again, so the list ends
// as it began; the recommendation dismissed is the fixture's own.
export const capabilitiesSamples: GroupSamples<`capabilities`> = () => ({
    list: undefined,
    add: { id: `smoke-agent`, kind: `agent`, config: { command: `pi --rpc`, loginCommand: `pi login` } },
    probe: { id: `stripe`, kind: `cli`, config: { provider: `stripe`, apiKey: `VAULTED` } },
    sshKey: undefined,
    login: { id: `smoke-agent` },
    rename: { id: `smoke-agent`, to: `smoke-agent-renamed` },
    remove: { id: `smoke-agent-renamed` },
    setSecret: { id: `stripe`, value: `sk_live_demo` },
    marketplace: { url: `https://github.com/acme/registry` },
    refs: { url: `https://github.com/acme/registry` },
    dismiss: { entry: `cloudflare` },
});
