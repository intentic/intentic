// The kit's DOM-free subpath, not the barrel: nothing here draws anything.
import { type AgentPanel, agentStateNote, agentProcessState, agentSkewNote, restartAgent } from "@intentic/ui/device-agent";
import { agentBuildSkew, agentStalled } from "@intentic/sandbox-contract/schemas/devices";
import type { DeviceStatus } from "./desktop";

// This machine's agent as the kit's AgentPanel — the same object the web Devices view builds from its device
// registry, so <DeviceEnvironmentRow> heads both pages with it. What differs is only what each side can answer:
// this window runs ON the device, so it reads the loop directly and has exactly one verb for it.

/** Restart alone: this app has no way to fetch a newer agent, and a button that can't is worse than none. */
type DesktopAgentOp = ReturnType<typeof restartAgent>[`op`];

/** Undefined when this device has no agent — an ordinary state here, not a failure. */
export const desktopAgentPanel = (status: DeviceStatus | undefined): AgentPanel<DesktopAgentOp> | undefined => {
    if (status === undefined) {
        return undefined;
    }
    const agent = status.sync.agent;
    // Both judged by the contract's own rules, the ones the web Devices tab and `intentic-machine status` apply, so the
    // three cannot disagree about this machine. A stall is read on the machine's clock, which stamped both the last
    // pass and the reading.
    const staleBuild = agentBuildSkew(agent);
    const reported = { ...agent, stalled: agentStalled(agent, status.sync.capturedAt), ...(staleBuild === undefined ? {} : { staleBuild }) };
    const notes = [agentStateNote(reported), agentSkewNote(staleBuild)].filter((note) => note !== undefined);
    return {
        version: status.version,
        state: agentProcessState(reported),
        facts: agent.pid === undefined ? [] : [`pid ${agent.pid}`],
        // A settled agent says nothing, as on the web's page: what Restart is for lives on its own hint.
        notes,
        // Always offered: this window is the device, so nothing stands between the press and the loop.
        actions: [restartAgent()],
        blocked: undefined,
    };
};
