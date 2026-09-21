// The kit's DOM-free subpath, not the barrel: nothing here draws anything.
import { type AgentNote, type AgentPanel, agentStateNote, agentProcessState, agentSkewNote, restartAgent } from "@intentic/ui/device-agent";
import type { DeviceStatus } from "./desktop";
import { t } from "@intentic/ui/i18n";

// This machine's agent as the kit's AgentPanel — the same object the web Devices tab builds from its device
// registry, so <DeviceAgentGroup> draws one block for both. What differs is only what each side can answer:
// this window runs ON the device, so it reads the loop directly and has exactly one verb for it.

/** Restart alone: this app has no way to fetch a newer agent, and a button that can't is worse than none. */
type DesktopAgentOp = ReturnType<typeof restartAgent>[`op`];

// An unstamped running build predates the stamp (older, not missing); `0.0.0` marks a working-tree agent, never
// stale.
const WORKING_TREE = `0.0.0`;

// The loop keeps the build it started with, so a binary replaced under a live process leaves the two apart.
const skewOf = (agent: DeviceStatus[`sync`][`agent`]): { running: string | undefined; installed: string } | undefined => {
    const installed = agent.installed;
    if (!agent.running || installed === undefined || installed === WORKING_TREE || agent.build === installed) {
        return undefined;
    }
    return { running: agent.build, installed };
};

// The quiet line that makes a standing Restart button legible: what it is for on an agent asking for nothing.
// Never carries a tone — there is no errand in it.
const settled = (): AgentNote => ({
    text: `Serving the build installed on this device.`,
    icon: `check-circle`,
    hint: t(`desktop.deviceAgent.whetherNewerAgentPublished`),
});

/** Undefined when this device has no agent — an ordinary state here, not a failure. */
export const desktopAgentPanel = (status: DeviceStatus | undefined): AgentPanel<DesktopAgentOp> | undefined => {
    if (status === undefined) {
        return undefined;
    }
    const agent = status.sync.agent;
    const staleBuild = skewOf(agent);
    const reported = { ...agent, ...(staleBuild === undefined ? {} : { staleBuild }) };
    const notes = [agentStateNote(reported), agentSkewNote(staleBuild)].filter((note) => note !== undefined);
    return {
        version: status.version,
        state: agentProcessState(reported),
        facts: agent.pid === undefined ? [] : [`pid ${agent.pid}`],
        notes: notes.length === 0 ? [settled()] : notes,
        // Always offered: this window is the device, so nothing stands between the press and the loop.
        actions: [restartAgent()],
        blocked: undefined,
    };
};
