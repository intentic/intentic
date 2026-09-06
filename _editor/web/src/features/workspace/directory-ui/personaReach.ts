import { ref } from "vue";
import type { Persona } from "@intentic/sandbox-contract";

/* SEEING THE WORKSPACE AS ONE PERSONA SEES IT, the lens behind "Viewing as" in the explorer.
 *
 * A persona's fence is the one setting on its card whose effect you cannot check by reading the card: `docs,
 * apps/web` tells you the words somebody typed, not whether they match anything, not what they leave out, and
 * not that `apps/web` was renamed last week and now refuses everything. The tree already knows the answer to
 * all three; it just was not being asked.
 *
 * A LENS, NOT A PERMISSION. Nothing here stops the person at the keyboard opening anything, they are not the
 * persona, and an explorer that refused its own user would be a bug wearing a feature's clothes. Dimmed means
 * "this persona's file tools would be refused here", which is a fact about a card, shown against the real tree.
 *
 * WHAT IS DELIBERATELY NOT MODELLED: the `sandbox` switch, which refuses WRITES to .intentic and public while
 * leaving reads alone. Painting those two rows for a write-only rule needs a third state between reachable and
 * refused, and a three-state dimming is a legend to learn rather than a thing to see. The fence is the whole of
 * what this shows, and the banner says so in those words.
 *
 * Mirrors persona-scope.ts, which is the daemon's enforcement of the same rule, deliberately, and the reason
 * the comparison here is by path segment rather than by string prefix: `apps/web2` is not inside `apps/web`. */

// Which persona the explorer is being read as, or nobody. Module-level for the same reason `workspaceAgent` is:
// the toolbar that sets it, the tree that dims by it and the banner that names it are not in one subtree.
export const lensPersonaId = ref<string | undefined>(undefined);

// Is `path` at or below `folder`? Both workspace-relative, forward-slashed, no trailing slash.
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
// Is `path` a folder you must pass THROUGH to get to `folder`? Those stay lit: dimming `intentic` on a card
// fenced to `intentic/_editor` would grey out the only road to the one folder the persona can actually use.
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

/* What the banner says, in a sentence rather than a field dump, and it opens with "Viewing as <name>" because
 * that is the half a reader needs on the glance where they have forgotten why the tree looks odd. The dimming
 * is not explained here: it explains itself once you know whose eyes you are using, and a strip that has to be
 * read twice on a 256px sidebar is a strip that gets read never. */
export const reachSentence = (name: string, reach: PersonaReach): string => {
    if (reach.readsNothing) {
        return `Viewing as ${name}: it has no file access at all, so every path here is refused to its file tools.`;
    }
    if (reach.folders.length === 0) {
        return `Viewing as ${name}: it works anywhere in the workspace, so nothing here is fenced off.`;
    }
    return `Viewing as ${name}: it works in ${reach.folders.join(`, `)}. Dimmed folders are refused to its file tools; you can still open them.`;
};
