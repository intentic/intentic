// Local desktop-sync folder naming, kept free of environment/DOM deps so it's a plain unit-testable helper.

export const slugify = (raw: string): string =>
    raw
        .replace(/[^a-zA-Z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .toLowerCase() || `sandbox`;

// Keyed on the sandbox id, not just the name: a torn-down sandbox recreated with the same name gets its own fresh
// folder instead of reusing the dead one's (which cleanup never deletes) and colliding on the two-way sync.
export const syncFolder = (name: string, id: string): string => `~/intentic/${slugify(name)}-${id.slice(-6) || `new`}`;
