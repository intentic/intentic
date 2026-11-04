import { STATE_DIR } from "@intentic/constants";
import type { AgentFix } from "../../../../models/fixes/agentFix";

// What a Fix with agent press asks about an environment rebuild that failed (agentFix.ts): the image is built from the
// approved steps in the state dir's `config/environment.d/`, so the fix is to one of those steps, proposed again for the
// owner to approve, never applied around them. English, like every brief.

export const environmentBuildFix = (failure: { readonly title: string; readonly reason?: string | undefined; readonly log: string; readonly where: string }): AgentFix => ({
    title: failure.title,
    repo: `root`,
    reason: failure.reason,
    output: failure.log,
    facts: [`The sandbox's environment image was being rebuilt ${failure.where}, from the steps in \`${STATE_DIR}/config/environment.d/\`.`],
    goal:
        `Find the step that broke the build from its log and fix it (a package renamed or gone, a URL that moved, a command that needs another first). ` +
        `Load the \`environment\` skill and propose the fixed step for me to approve; do not rebuild or restart the sandbox yourself.`,
    tree: `shared`,
});
