import type { ParentCredentials } from "./runner-credentials.js";
import type { RunnerHub, RunnerStore } from "./runner-peer.js";

// This sandbox's runners: their door and hub, and the parent a runner-mode daemon reports to.
export interface RunnersSlice {
    // This sandbox's own runner containers on other machines: same enrollment and hub, no grant, no MCP bridge.
    readonly runners: RunnerStore;
    readonly runnerHub: RunnerHub;
    // Set only when this daemon is a runner: the parent sandbox as a credential source, read off /history at boot.
    readonly runnerParent: { current?: ParentCredentials };
}
