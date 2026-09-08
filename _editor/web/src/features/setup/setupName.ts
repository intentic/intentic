// Default sandbox name for an account with none yet: `workspace`, then `workspace-2`, etc. The suffix counts from
// names the account already holds, not from how many exist, so removing a middle one frees its slot again.
// Comparison is case-insensitive and trimmed.

const BASE = `workspace`;

export const autoSandboxName = (existing: readonly string[]): string => {
    const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
    if (!taken.has(BASE)) {
        return BASE;
    }
    // Bounded by the loop's own condition: every candidate up to `taken.size + 1` cannot all be taken.
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${BASE}-${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
};
