import { ref } from "vue";
import type { Persona } from "@intentic/sandbox-contract";

// "Viewing as" lens: shows what a persona's folder fence actually resolves to, not just the raw text on its card.
// A lens, not a permission — it dims, never blocks, the real user. Doesn't model the sandbox write-only rule
// (no three-state dimming); mirrors persona-scope.ts, comparing by path segment so `apps/web2` isn't inside `apps/web`.

// Which persona the explorer reads as, or nobody; module-level since the toolbar, tree and banner aren't in one
// subtree.
export const lensPersonaId = ref<string | undefined>(undefined);

// Is `path` at or below `folder`? Both workspace-relative, forward-slashed, no trailing slash.
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
// Is `path` a folder you must pass through to reach `folder`? These stay lit rather than dimmed.
const leadsTo = (path: string, folder: string): boolean => folder.startsWith(`${path}/`);

export interface PersonaReach {
    /** The folders the card names, for the banner. Empty ⇒ the whole workspace. */
    readonly folders: readonly string[];
    /** True when this persona's file tools would be refused this path outright. */
    readonly refuses: (path: string) => boolean;
    /** A card whose file access is `none` reaches nothing at all, whatever its folders say. */
    readonly readsNothing: boolean;
}

export const reachOf = (persona: Persona): PersonaReach => {
    const folders = persona.workspace?.folders ?? [];
    const readsNothing = persona.powers?.files === `none`;
    return {
        folders,
        readsNothing,
        refuses: (path: string): boolean => {
            if (readsNothing) {
                return true;
            }
            if (folders.length === 0) {
                return false;
            }
            return !folders.some((folder) => within(path, folder) || leadsTo(path, folder));
        },
    };
};

// One sentence rather than a field dump; opens with "Viewing as <name>", the fact a reader forgetting why the
// tree looks odd needs first.
export const reachSentence = (name: string, reach: PersonaReach): string => {
    if (reach.readsNothing) {
        return `Viewing as ${name}: it has no file access at all, so every path here is refused to its file tools.`;
    }
    if (reach.folders.length === 0) {
        return `Viewing as ${name}: it works anywhere in the workspace, so nothing here is fenced off.`;
    }
    return `Viewing as ${name}: it works in ${reach.folders.join(`, `)}. Dimmed folders are refused to its file tools; you can still open them.`;
};
