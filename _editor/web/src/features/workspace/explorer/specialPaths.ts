import { MEMORY_FILE } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";

// Entries the sandbox itself treats specially, where nothing about the name says so: the shelf it never edits, the
// folder it serves to the open internet, the file it reads into every turn. One table, read by both trees, so a role
// cannot be marked on the desktop and invisible on mobile. A locked path is not here: the padlock already marks it.

export interface SpecialChip {
    readonly label: string;
    // "warning" is for a role that can surprise; what lands in that folder leaves the sandbox.
    readonly tone: "subtle" | "warning";
    readonly tooltip: string;
}

// Root-relative paths, forward-slashed, as the tree rows carry them.
const RULES: readonly { readonly matches: (path: string) => boolean; readonly chip: SpecialChip }[] = [
    {
        // Root only: a repo's own refs/ is ordinary content.
        matches: (path) => path === REFERENCE_DIR,
        chip: {
            label: `reference`,
            tone: `subtle`,
            tooltip: `Material to consult, never workspace code: excluded from search, dependency setup and sync.`,
        },
    },
    {
        matches: (path) => path === PUBLIC_DIR,
        chip: { label: `public`, tone: `warning`, tooltip: `Served on the open internet, to anyone with the link, with no sign-in.` },
    },
    {
        // At any depth: a folder's own memory file is read by a conversation that starts in it, on top of the root's.
        matches: (path) => path.split(`/`).at(-1) === MEMORY_FILE,
        chip: {
            label: `memory`,
            tone: `subtle`,
            tooltip: `Standing instructions, read into every turn that starts in this folder or deeper, whichever model runs it.`,
        },
    },
];

export const specialChip = (path: string): SpecialChip | undefined => RULES.find(({ matches }) => matches(path))?.chip;
