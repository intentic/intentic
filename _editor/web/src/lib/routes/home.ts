// Home spans sandboxes, so the per-sandbox screen memory must leave its navigation to the home surface.
export const isHomePath = (path: string): boolean => /^\/home(?:[/?#]|$)/.test(path);

// The person's own pages (settings), which belong to no one sandbox: opened from the master view they keep its rail, so
// the account control's Settings is a visit, not a way back into whichever sandbox happened to be active.
const PERSONAL = /^\/settings(?:[/?#]|$)/;

/** Account pages stay available without a connected sandbox or a completed setup. */
export const isAccountPath = (path: string): boolean => isHomePath(path) || PERSONAL.test(path);

/** Whether the rail stays the master view's after a navigation to `path`, given whether it was before. */
export const masterRailAfter = (wasMaster: boolean, path: string): boolean => isHomePath(path) || (wasMaster && PERSONAL.test(path));
