import { type Ref, watch } from "vue";

/* WHERE YOU LEFT A NARROWING MENU, the one piece of state these rails could not keep.
 *
 * Every one of them already holds its choice in the URL: a repository in Maintenance and Pipelines, a platform in
 * Drafts, a category in Capabilities. That is why picking one survives a reload and can be sent to somebody as a
 * link. What it does not survive is LEAVING, the rail tile opens a view at its bare address, so coming back
 * always landed on "all", and the reader re-picked the same row on every single visit.
 *
 * So this seeds the URL rather than replacing it. On the first render where the rail knows what it can offer, a
 * view that arrived with no choice of its own takes the remembered one and writes it to the query like any other
 * pick, so the address bar, Back, and a copied link still all agree with what is on screen. The alternative,
 * holding the restored value privately, would put the rail and the URL into two different states and make the
 * link somebody shares show a different page from the one they were looking at.
 *
 * VALIDATED AGAINST THE LIVE OPTIONS, which is what lets one remembered value sit behind every workspace without
 * being scoped to any of them. A repository that has been removed, or one that only ever existed in another
 * sandbox, simply fails the check and the rail opens on "all", a remembered name can never select an empty list.
 *
 * A DEEP LINK ALWAYS WINS. A choice in the URL is somebody being deliberate, a shared link, a bookmark, the Back
 * button, where a remembered value is only a guess about what they last wanted. The guess speaks when nobody
 * else has, and not otherwise.
 *
 * ONLY THE MENU CHOICE, never the rest of a view's query. A remembered scope is help; a search box that refills
 * itself with words you typed last Tuesday is a view that looks empty for no reason you can see. */

const keyOf = (id: string): string => `intentic.rail.${id}`;

// `` is how a rail modelled on a plain string spells "all" (a <Picker> has no undefined to offer), and the rails
// that can be undefined mean the same thing by it. Both are "nothing has been narrowed to", so both read alike.
const isEmpty = (value: string | undefined): boolean => value === undefined || value === ``;

const read = (id: string): string | undefined => {
    try {
        return localStorage.getItem(keyOf(id)) ?? undefined;
    } catch {
        // Storage may be unavailable (private mode); the rail opens on its default, which is the state it had
        // before any of this existed.
        return undefined;
    }
};

/**
 * Remember a narrowing rail's choice, and restore it the next time its view opens without one.
 *
 * `options` is the set of values currently on offer, read reactively, these arrive with a report rather than
 * with the component, so the restore waits for them instead of running on mount against an empty list.
 */
export function useRailMemory(id: string, choice: Ref<string | undefined>, options: () => readonly string[]): void {
    // "All" is a choice too, and writing it is what lets someone who deliberately widened the scope keep it wide
    // instead of being pushed back into last week's repository every time they return.
    watch(choice, (value) => {
        try {
            localStorage.setItem(keyOf(id), value ?? ``);
        } catch {
            // Storage may be unavailable; the choice still holds for this visit.
        }
    });

    // One shot: the first render where the rail actually has rows. After that the reader is driving, and a second
    // restore would fight them.
    let restored = false;
    watch(
        options,
        (values) => {
            if (restored || values.length === 0) {
                return;
            }
            restored = true;
            const held = read(id);
            // Nothing to restore if the last visit ended on "all", that is already where a view opens.
            if (isEmpty(choice.value) && !isEmpty(held) && held !== undefined && values.includes(held)) {
                choice.value = held;
            }
        },
        { immediate: true },
    );
}
