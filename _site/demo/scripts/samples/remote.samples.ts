import type { GroupSamples } from "./context.ts";

// A person's screen and terminals on the fixture's paired computer. The terminal attached to, refreshed and closed is
// the one the demo already holds open there (src/daemon/machine/remote.handler.ts), so closing it is the run's last
// step and nothing it opened outlives it but the fresh one.
export const remoteSamples: GroupSamples<`remote`> = ({ host }) => ({
    status: { device: host },
    openScreen: { device: host },
    openTerminal: { device: host, environment: `native`, cols: 120, rows: 32 },
    attachTerminal: { device: host, session: `t-7Fq2pX` },
    refresh: { device: host, session: `t-7Fq2pX` },
    closeTerminal: { device: host, session: `t-7Fq2pX` },
});
