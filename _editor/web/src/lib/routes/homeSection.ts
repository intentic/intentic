import type { IconName } from "@intentic/ui";
import { removeStoredValue, storedJson, storeJson } from "@intentic/ui/storage";
import { ref } from "vue";
import { z } from "zod";

// WHAT HOME SHOWS OF EACH SANDBOX (2026-10-29). By default its home conversation, at /home. The reader may choose one of a
// sandbox's own sections instead (its Chat, its Board, its Workspace, an extension's view: the tiles its own rail
// offers), from the foot of Home's rail (shell/rail/HomeSectionPicker.vue), the way Show a file picks one file for every
// folder of the Workspace. Then a press on a sandbox's tile opens that section of it, and Home itself opens on it.
// The section runs on its own address, since every section keeps its state there (the Workspace writes the open file
// into the path the moment it mounts); what stays Home's is the frame around it, the rail of sandboxes, for as long as
// the address is that section's own (models/home/masterRail.ts). Every section but the Chat docks the sandbox's chat panel
// to its right, as inside the sandbox.
//
// One choice for every sandbox on this device, like the chat's home: it is how the reader likes to look at their
// sandboxes, not a fact about one of them. Here, below every model, since the shell, the chat's layout and a sandbox's
// screen memory all read it.

/** A section of a sandbox, as Home remembers the one chosen: its rail tile's identity, address and look. */
export interface HomeSection {
    /** The tile's id: `chat`, `agents`, `workspace`, `devices`, or an extension's. */
    readonly id: string;
    /** Its address inside a sandbox, which owns every address below it too (a file in the Workspace, an agent on the Board). */
    readonly to: string;
    /** Its name as the tile said it when it was chosen, for the rail's hover while the list of tiles is not read. */
    readonly label: string;
    readonly icon?: IconName;
    readonly monogram?: string;
}

const KEY = `ui-home-section`;
const STORED = z.object({
    id: z.string().min(1),
    to: z.string().startsWith(`/`),
    label: z.string().min(1),
    icon: z.string().min(1).optional(),
    monogram: z.string().min(1).optional(),
});

/** The choice kept on this device, or nothing for anything that is not one (none kept, an older shape, a hand-edited key). */
export const storedHomeSection = (): HomeSection | undefined => {
    const stored = storedJson(KEY, STORED);
    if (stored === undefined) {
        return undefined;
    }
    const { icon, ...section } = stored;
    // SAFETY: the name the tile itself handed over when it was chosen; RailIcon draws initials for one this build lacks.
    return icon === undefined ? section : { ...section, icon: icon as IconName };
};

/** The section Home shows of every sandbox; nothing is the home conversation. Chosen with `chooseHomeSection`. */
// allow(module-state): one choice per device, the same whichever sandbox is selected
export const homeSection = ref<HomeSection | undefined>(storedHomeSection());

/** Chooses what Home shows of every sandbox, and keeps it on this device; nothing goes back to the home conversation. */
export const chooseHomeSection = (section: HomeSection | undefined): void => {
    homeSection.value = section;
    if (section === undefined) {
        removeStoredValue(KEY);
    } else {
        storeJson(KEY, section);
    }
};

/**
 * What Home's frame is around when it is around a section of a sandbox rather than a page of Home's or the person's own:
 * the sandbox's Chat, which is a chat already (`chat`), or any other section, which has the sandbox's chat panel docked to
 * its right (`docked`). Written by the shell as it follows the router (models/home/masterRail.ts).
 */
export type HomeFrame = `chat` | `docked`;

// allow(module-state): one shell per window, and what its frame holds is a property of that window
export const homeFrame = ref<HomeFrame | undefined>();

const pathOf = (address: string): string => address.split(/[?#]/, 1)[0] ?? address;

/** Whether an address is the section's own: the section itself or anything below it, its query and hash aside. */
export const sectionOwns = (section: Pick<HomeSection, "to"> | undefined, address: string): boolean => {
    if (section === undefined) {
        return false;
    }
    const path = pathOf(address);
    return path === section.to || path.startsWith(`${section.to}/`);
};
