import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";

// A fenced conversation runs only where its fence holds: inside a sandbox (turn-sandbox.ts), under a runtime whose own
// state the sandbox can carry. Codex and Cursor keep one sandbox-wide home holding every conversation's sessions, and a
// runtime that never enters a namespace would read the whole tree, so all of those are refused rather than run open.
export const fencedRefusal = async (services: Pick<Services, "turnIsolation">, input: RoutedTurn): Promise<string | undefined> => {
    const capabilities = capabilitiesOf(input.agent, input.harness);
    if (capabilities.isolation !== "namespace" || capabilities.runtime !== "claude-code") {
        return "This conversation is limited to some areas of the workspace, and only Claude Code can run such a conversation so far. Switch it to a Claude model to continue.";
    }
    if (!(await services.turnIsolation.sandboxAvailable())) {
        return "This conversation is limited to some areas of the workspace, and this sandbox cannot build the isolated environment that needs (bubblewrap with user namespaces). Ask a maintainer to recreate the sandbox.";
    }
    return undefined;
};
