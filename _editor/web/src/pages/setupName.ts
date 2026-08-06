/* THE NAME A SANDBOX GETS WITHOUT BEING ASKED FOR ONE.
 *
 * Setup used to open on an empty field and a Create button that stayed dead until something was typed, which
 * put an invented word between a new account and everything the product does. A name is only ever there to
 * tell sandboxes apart in the switcher, and the first one has nothing to be told apart from — so the first one
 * is `workspace` and the next is `workspace-2`, exactly like the untitled documents every other tool hands out.
 *
 * The suffix counts from the names the account ALREADY holds rather than from how many there are: an account
 * with `workspace` and `workspace-3` gets `workspace-2` back, and a sandbox removed from the middle frees its
 * name again. Comparison is case-insensitive and trimmed because that is how a human reads two rows of a list
 * — `Workspace` and `workspace` are the same word on screen, whatever the database thinks. */

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
