import { MEMORY_FILE } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import type { Tip } from "@intentic/ui";
import type { Vocabulary } from "../../../workbench/views/vocabulary";
import { t } from "@intentic/ui/i18n";

// Entries the sandbox itself treats specially, where nothing about the name says so: the shelf it never edits, the
// folder it serves to the open internet, the file it reads into every turn. One table, read by both trees, so a role
// cannot be marked on the desktop and invisible on mobile. A locked path is not here: the padlock already marks it.
// The words come from the audience's vocabulary, so a maker reads "shared" where a developer reads "public".

export interface SpecialChip {
    readonly label: string;
    // "warning" is for a role that can surprise; what lands in that folder leaves the sandbox.
    readonly tone: "subtle" | "warning";
    readonly tooltip: Tip;
}

// Root-relative paths, forward-slashed, as the tree rows carry them.
const RULES: readonly { readonly matches: (path: string) => boolean; readonly chip: (words: Vocabulary) => SpecialChip }[] = [
    {
        // Root only: a repo's own refs/ is ordinary content.
        matches: (path) => path === REFERENCE_DIR,
        chip: (words) => ({
            label: words.referenceChip,
            tone: `subtle`,
            tooltip: { title: t(`workspace.specialPaths.referenceOnly`), note: t(`workspace.specialPaths.noSearchSetupSync`) },
        }),
    },
    {
        matches: (path) => path === PUBLIC_DIR,
        chip: (words) => ({
            label: words.publicChip,
            tone: `warning`,
            tooltip: { title: words.publicTooltip, tone: `warn`, note: t(`workspace.specialPaths.noSignIn`) },
        }),
    },
    {
        // At any depth: a folder's own memory file is read by a conversation that starts in it, on top of the root's.
        matches: (path) => path.split(`/`).at(-1) === MEMORY_FILE,
        chip: (words) => ({
            label: words.memoryChip,
            tone: `subtle`,
            tooltip: { title: t(`workspace.specialPaths.standingInstructions`), note: words.memoryTooltip },
        }),
    },
];

export const specialChip = (path: string, words: Vocabulary): SpecialChip | undefined => RULES.find(({ matches }) => matches(path))?.chip(words);
