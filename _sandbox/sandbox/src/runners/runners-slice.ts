import type { RunnerFacts } from "@intentic/sandbox-contract";
import { createPeerHub, type PeerDoorDeps } from "../peers/peer-hub.js";
import { filePeerStore } from "../peers/peer-store.js";
import type { ParentCredentials } from "./runner-credentials.js";
import { RUNNER_PEER, type RunnerAnnounced, type RunnerClient, type RunnerHub, type RunnerStore } from "./runner-peer.js";

// This sandbox's runners: their door and hub, and the parent a runner-mode daemon reports to.
export interface RunnersSlice {
    // This sandbox's own runner containers on other machines: same enrollment and hub, no grant, no MCP bridge.
    readonly runners: RunnerStore;
    readonly runnerHub: RunnerHub;
    // Set only when this daemon is a runner: the parent sandbox as a credential source, read off /history at boot.
    // Genuinely late, so a holder: runner mode enrolls after the boot gate opens (main.ts), long after composing.
    readonly runnerParent: { current?: ParentCredentials };
}

// Builds the runners slice: the same peer door as a device or a browser, with the parent left for runner mode to fill.
export const createRunnersSlice = ({ historyRoot, logger, peerTools }: PeerDoorDeps): RunnersSlice => ({
    runners: filePeerStore(historyRoot, RUNNER_PEER.store),
    runnerHub: createPeerHub<RunnerClient, RunnerAnnounced, RunnerFacts, never>(RUNNER_PEER.hub, logger, peerTools),
    runnerParent: {},
});
