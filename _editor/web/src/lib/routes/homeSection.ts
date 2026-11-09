import { SANDBOX_PAGES } from "@intentic/sandbox-contract/app-routes";
import type { IconName } from "@intentic/ui";
import { removeStoredValue, storedJson, storeJson } from "@intentic/ui/storage";
import { computed, ref } from "vue";
import { z } from "zod";
import { currentRoute, frameOf, isSandboxPage, linkOf, type PageLink, pageCovers, pageOf, type SandboxPageName } from "./links";

// WHAT HOME SHOWS OF EACH SANDBOX (2026-10-29). By default its home conversation, at /home/<sandbox>. The reader may choose
// one of a sandbox's own sections instead (its Chat, its Board, its Workspace, an extension's view: the tiles its own rail
// offers), from the foot of Home's rail (shell/rail/HomeSectionPicker.vue), the way Show a file picks one file for every
// folder of the Workspace. Then a press on a sandbox's tile opens that section of it in Home's frame, and Home itself
// opens on it. The section runs on its own address, `/home/<sandbox>/<page>`, since every section keeps its state there
// (the Workspace writes the open file into the path the moment it mounts), and that address says the frame is Home's
// (models/home/masterRail.ts).
//
// ONE VIEW, THE RAIL UNROLLED OR FOLDED (2026-11-09). Home's frame is no second screen: it is the same shell with the
// sandboxes unrolled along the rail and the sections put away in the bookmark at its foot. Unrolling keeps the page on
// screen (models/sandbox/sandboxScreen.ts `unrolledPath`), a press on another sandbox's tile shows the same section of
// that one (`sameViewPath`, by `sectionOfPage` below), and everything beside the rail is laid out as it is folded. What
// is kept here is only where Home opens when no page is named: the bare address, the first screen.
//
// One choice for every sandbox on this device, like the chat's home: it is how the reader likes to look at their
// sandboxes, not a fact about one of them. Here, below every model, since the shell, the chat's layout and a sandbox's
// screen memory all read it.

/** A section's page: which page of a sandbox, and the values that pick it (an extension's view names its extension). */
export interface SectionPage {
    readonly name: SandboxPageName;
    readonly params: Readonly<Record<string, string>>;
}

/** A section of a sandbox, as Home remembers the one chosen: its rail tile's identity, page and look. */
export interface HomeSection {
    /** The tile's id: `chat`, `agents`, `workspace`, `devices`, or an extension's. */
    readonly id: string;
    /** Its page in a sandbox, which owns every address below it too (a file in the Workspace, an agent on the Board). */
    readonly page: SectionPage;
    /** Its name as the tile said it when it was chosen, for the rail's hover while the list of tiles is not read. */
    readonly label: string;
    readonly icon?: IconName;
    readonly monogram?: string;
}

const KEY = `ui-home-section`;
// SAFETY: SANDBOX_PAGES is a const literal whose own keys are exactly SandboxPageName; Object.keys only widens their type.
const PAGE_NAME = z.enum(Object.keys(SANDBOX_PAGES) as [SandboxPageName, ...SandboxPageName[]]);
const LOOK = { label: z.string().min(1), icon: z.string().min(1).optional(), monogram: z.string().min(1).optional() };
const STORED = z.object({ id: z.string().min(1), page: z.object({ name: PAGE_NAME, params: z.record(z.string(), z.string()) }), ...LOOK });
// Kept by a build from before frames (2026-11-04): the section's address inside a sandbox, read as the page it names.
const STORED_ADDRESS = z.object({ id: z.string().min(1), to: z.string().startsWith(`/`), ...LOOK });

/** The page a section's tile opens (its `to`, in either form an address comes in), when it is a page of a sandbox. */
export const sectionPageOf = (address: string): SectionPage | undefined => {
    const link = linkOf(address);
    if (link === undefined || !isSandboxPage(link.page)) {
        return undefined;
    }
    const params = Object.entries(link.params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ``);
    return { name: link.page, params: Object.fromEntries(params) };
};

/** The choice kept on this device, or nothing for anything that is not one (none kept, an unreadable shape, a hand-edited key). */
export const storedHomeSection = (): HomeSection | undefined => {
    const stored = storedJson(KEY, z.union([STORED, STORED_ADDRESS]));
    if (stored === undefined) {
        return undefined;
    }
    const sectionPage = `page` in stored ? stored.page : sectionPageOf(stored.to);
    if (sectionPage === undefined) {
        return undefined;
    }
    const { id, label, icon, monogram } = stored;
    const section: HomeSection = monogram === undefined ? { id, page: sectionPage, label } : { id, page: sectionPage, label, monogram };
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

/** The section's own page as a link, nothing open in it yet. */
export const sectionLink = (section: Pick<HomeSection, `page`>): PageLink => ({
    page: section.page.name,
    params: section.page.params,
    query: {},
    hash: ``,
});

/**
 * Whether a page is the section's own: its page, with the values the section names (an extension's view, which of its
 * views), or a page below it (an agent of the board). Whatever else the page holds (a file, a tab) is the section's.
 */
export const showsSection = (section: Pick<HomeSection, `page`>, link: PageLink): boolean => pageCovers(sectionLink(section), link);

/** Whether two sections are the same page of a sandbox (two views of one extension are two sections). */
export const sameSection = (left: Pick<HomeSection, `page`> | undefined, right: Pick<HomeSection, `page`> | undefined): boolean =>
    left !== undefined && right !== undefined && showsSection(left, sectionLink(right)) && showsSection(right, sectionLink(left));

/**
 * The section a page belongs to, as the rail's tile would name it: the page itself with nothing open in it (no file, no
 * tab, no catalog entry), the board for an agent opened from it, and the two pages whose values say WHICH view they are
 * kept whole (an extension's view, a section of the sandbox's settings). Nothing for a page that is no sandbox's. Read
 * off the address alone, so the rail can say what is on screen without reading any sandbox's list of tiles.
 */
export const sectionOfPage = (link: Pick<PageLink, `page` | `params`>): SectionPage | undefined => {
    if (!isSandboxPage(link.page)) {
        return undefined;
    }
    if (link.page === `agent` || link.page === `agentPage`) {
        return { name: `agents`, params: {} };
    }
    const whole = link.page === `extension` || link.page === `sandboxSettings`;
    const params = whole ? Object.entries(link.params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ``) : [];
    return { name: link.page, params: Object.fromEntries(params) };
};

/**
 * Whether the rail of sandboxes stands around a page of a sandbox, rather than around Home's own chat or the account's
 * pages. Then everything beside the rail is the sandbox's, exactly as with the rail folded (2026-11-09): its status
 * bar, its chat in the home the reader keeps it in, what was opened beside. Read off the address, which says the frame
 * (lib/routes/links.ts).
 */
export const sandboxPageInHome = computed((): boolean => {
    const route = currentRoute();
    const shown = route === undefined || frameOf(route) !== `home` ? undefined : pageOf(route);
    return shown !== undefined && isSandboxPage(shown);
});
