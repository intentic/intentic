// Home spans sandboxes, so the per-sandbox screen memory must leave its navigation to the home surface.
export const isHomePath = (path: string): boolean => /^\/home(?:[/?#]|$)/.test(path);

/**
 * The account's deleted sandboxes: a page of the account's, like Settings, never a section of one sandbox's screen, since
 * the trash is every sandbox the account deleted, wherever it ran, and recovery has to work with no sandbox left at all.
 */
export const DELETED_PATH = `/deleted-sandboxes`;

// Settings and deleted sandboxes belong to the account. Opened from Home, they keep its rail instead of entering
// whichever sandbox happened to be active.
const PERSONAL = /^\/(?:settings(?:[/?#]|$)|deleted-sandboxes\/?(?:[?#]|$))/;

/** Account pages stay available without a connected sandbox or a completed setup. */
export const isAccountPath = (path: string): boolean => isHomePath(path) || PERSONAL.test(path);

/**
 * Whether the rail stays the master view's after a navigation to `path`, given whether it was before and whether the path
 * is the section Home was asked to show of every sandbox (homeSection.ts): that section's own pages keep Home's
 * frame as the person's own do, and anything else of a sandbox gives the rail back.
 */
export const masterRailAfter = (wasMaster: boolean, path: string, homeSectionOwns = false): boolean =>
    isHomePath(path) || (wasMaster && (PERSONAL.test(path) || homeSectionOwns));
