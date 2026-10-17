import type { AgentSummary, LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import { track } from "../../app/analytics";
import { landFailureCode } from "./agentStatus-attention";

type FailureAgent = Pick<AgentSummary, `id` | `landFailure` | `status` | `attention` | `conflictCauses` | `diff`>;
interface FailureProperties {
    readonly code: string;
    refused_count?: number;
    delta_files?: number;
}

// Observe server summaries, not component renders: the same agent can have several cards and a review open at once.
// Only categories and counts leave the editor; git's message and the refused paths can contain workspace content.
export const createLandFailureObserver = (capture: (event: string, properties: FailureProperties) => void) => {
    const seen = new Map<string, string>();
    return (agent: FailureAgent, sandbox: string | undefined, conflicts?: readonly LandConflict[]): void => {
        const key = JSON.stringify([sandbox, agent.id]);
        const failure = agent.landFailure;
        const conflict = agent.attention.conflict || agent.status === `conflict`;
        const signature = failure !== undefined ? `failure:${failure.at}` : conflict ? `conflict` : undefined;
        if (signature === undefined) {
            seen.delete(key);
            return;
        }
        if (seen.get(key) === signature) { return; }
        seen.set(key, signature);
        const code = failure === undefined
            ? agent.conflictCauses?.length === 1 ? agent.conflictCauses[0] ?? `conflict` : `conflict`
            : landFailureCode(failure.reason, failure.code) ?? `git_failed`;
        const properties: FailureProperties = { code };
        if (conflict && conflicts !== undefined) {
            properties.refused_count = conflicts.reduce((count, repo) => count + repo.paths.length, 0);
        }
        if (agent.diff !== undefined) {
            properties.delta_files = agent.diff.files;
        }
        capture(`land_failed`, properties);
    };
};

export const observeLandFailure = createLandFailureObserver(track);
