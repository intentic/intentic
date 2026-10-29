import type { RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { t } from "@intentic/ui/i18n";
import { branchLabel } from "../../../app/workspaceScope";

// WHERE A CONVERSATION STARTED FROM A BRANCH PUTS ITS WORK: committed onto that branch (AgentSummary.branches), not landed
// in the shared workspace, which stays on its main line. So its land press and its landed line say so, by the branch's
// name, wherever they are drawn.

/** The branch (or branches) a conversation's land commits onto, as one name; undefined for one on the main line. */
export const landsOnto = (branches: readonly RepoBranch[] | undefined): string | undefined => {
    if (branches === undefined || branches.length === 0) {
        return undefined;
    }
    return branches.length === 1 && branches[0] !== undefined ? branches[0].branch : branches.map(branchLabel).join(`, `);
};

/** The land press's words: the vocabulary's own on the main line, "Commit to <branch>" for a branch start. */
export const landWord = (branches: readonly RepoBranch[] | undefined, land: string): string => {
    const onto = landsOnto(branches);
    return onto === undefined ? land : t(`agents.branchStart.commitTo`, { branch: onto });
};

/** "from <repo> · <branch>", the card's note of where a conversation started; undefined for the main line. */
export const startedFrom = (branches: readonly RepoBranch[] | undefined): string | undefined =>
    branches === undefined || branches.length === 0 ? undefined : t(`agents.branchStart.from`, { branch: branches.map(branchLabel).join(`, `) });
