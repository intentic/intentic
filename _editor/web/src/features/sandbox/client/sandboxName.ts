// Default sandbox name for an account with none yet: `workspace`, then `workspace-2`, etc. The suffix counts from
// names the account already holds, not from how many exist, so removing a middle one frees its slot again.
// Comparison is case-insensitive and trimmed. A project setup counts up from its folder's name the same way.

const BASE = `workspace`;

// The platform refuses a longer name (`sandbox.create`), and a folder's name can run to any length.
const NAME_MAX = 60;

export const autoSandboxName = (existing: readonly string[], base: string = BASE): string => {
    const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
    // Cut to leave room for the suffix, so a long folder name still fits once it is numbered.
    const named = (suffix: string): string => `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(named(``).toLowerCase())) {
        return named(``);
    }
    // Bounded by the loop's own condition: every candidate up to `taken.size + 1` cannot all be taken.
    for (let suffix = 2; ; suffix += 1) {
        const candidate = named(`-${suffix}`);
        if (!taken.has(candidate.toLowerCase())) {
            return candidate;
        }
    }
};
