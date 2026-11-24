import type { FixtureRouter } from "@intentic/contract-serve";
import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import { agentProcedures } from "./procedures/agent.js";
import { agentsProcedures } from "./procedures/agents.js";
import { accountsProcedures, providersProcedures } from "./procedures/providers.js";
import { type HostAgentsOptions, type HostFolder, HostState } from "./state.js";

// AGENTS ON THIS COMPUTER, served as the sandbox contract's own turns so the editor's chat draws them as it draws a
// sandbox's. One of these stands behind every window of the desktop app; a window sees the conversations of the folder
// it shows, and a conversation works in that folder, where the folder is: on this computer's own side, or in the WSL
// distro that holds it.
//
// What is deliberately absent, next to a sandbox: no private copy of the folder and no landing (an agent here edits the
// reader's own files as they are), no fence around the agent (it runs as the reader), no subagents, automations, loops
// or schedules, no credentials of Intentic's, and nothing that reaches this from another machine. A sandbox is where
// work that should be contained, unattended or shared belongs; this is the reader's own harness with a chat on it.

export interface HostAgents {
    // Every procedure a window on `folder` is answered: the contract's agent, agents, providers and accounts groups.
    readonly proceduresFor: (folder: HostFolder) => Required<Pick<FixtureRouter, `agent` | `agents` | `providers` | `accounts`>>;
    // The roster frames a window on `root` hears on its event stream.
    readonly subscribe: (root: string, listener: (event: SystemEvent) => void) => () => void;
    // How many turns run now, for the app's question before it quits.
    readonly running: () => number;
    readonly onRunningChanged: (listener: (running: number) => void) => () => void;
    // Stops every turn and every harness process: the process serving this is going away.
    readonly close: () => void;
}

export const createHostAgents = (options: HostAgentsOptions): HostAgents => {
    const state = new HostState(options);
    return {
        proceduresFor: (folder) => ({
            agent: agentProcedures(state, folder),
            agents: agentsProcedures(state, folder),
            providers: providersProcedures(state, folder),
            accounts: accountsProcedures(state, folder),
        }),
        subscribe: (root, listener) => state.subscribe(root, listener),
        running: () => state.live.size,
        onRunningChanged: (listener) => state.onRunningChanged(listener),
        close: () => {
            state.interruptAll();
            state.connections.closeAll();
        },
    };
};
