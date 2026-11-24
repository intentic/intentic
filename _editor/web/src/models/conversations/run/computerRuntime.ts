import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import { localFace } from "../../../app/environments/local";

// WHAT A HARNESS CAN DO WHEN IT RUNS ON THIS COMPUTER ITSELF (local/agents/, _devices/host-agents), where the contract's
// table speaks of the sandbox's own loop for that provider. Every harness there is driven the same way, over the Agent
// Client Protocol by the app's sidecar, so what differs from a sandbox is the same for all of them:
//
// - `steering`: a message sent while a turn runs is not said into it. It waits and goes out as the next turn, and the
//   composer says so rather than "steer".
// - `permissions`: every harness is put in its asking mode, its plan mode or its accept-edits mode by the sidecar, so
//   all three postures are offered, the asking one included, for a provider whose sandbox loop has only two. Without
//   this a chat on such a provider would clamp to the unattended posture (clampMode), which nothing here contains.
// - `fastMode`, `warm`: a sandbox's levers on the provider's API, which the reader's own harness does not hand over.

/** A sandbox loop's capabilities as that provider's harness has them on this computer. Pure. */
export const computerCapabilities = (sandbox: AgentCapabilities): AgentCapabilities => ({
    ...sandbox,
    steering: false,
    permissions: `modes`,
    fastMode: false,
    warm: false,
});

/** The capabilities a chat in this window plans against: the sandbox's, or in a desktop window on a folder, this computer's. */
export const capabilitiesHere = (sandbox: AgentCapabilities): AgentCapabilities => (localFace() === undefined ? sandbox : computerCapabilities(sandbox));
