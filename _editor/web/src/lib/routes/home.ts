// Home spans sandboxes, so the per-sandbox screen memory must leave its navigation to the home surface.
export const isHomePath = (path: string): boolean => /^\/home(?:[/?#]|$)/.test(path);
