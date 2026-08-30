/* WHO IS REPORTING, in the only sense this SDK has one: a per-browser id, minted here, kept in localStorage.
 *
 * NOT IDENTITY AND NOT A SECRET. Anyone can mint one, and the daemon treats it as exactly what it is: the key
 * its per-minute rate window counts against, so one runaway tab cannot spend the whole day's budget and so a
 * proof of work solved by one reporter cannot be carried to another. Nothing about who a person is rides here;
 * a name or an address is something they type into the dialog, and it reaches the agent labelled unverified. */

// Namespaced per intake: two reporters on one site are two clients, and clearing one must not disturb the other.
const key = (automationId: string): string => `intentic.issues.${automationId}.client`;

/* localStorage throws in Safari's private mode and anywhere the site blocks storage. A page with no storage
 * still reports fine, it just mints a fresh id per load, which costs only a slightly less useful rate-limit
 * key. Silence here is deliberate: a reporter must never be the thing that puts an error in the console. */
const read = (name: string): string | undefined => {
    try {
        return window.localStorage.getItem(name) ?? undefined;
    } catch {
        return undefined;
    }
};

const write = (name: string, value: string): void => {
    try {
        window.localStorage.setItem(name, value);
    } catch {
        /* no storage: this page load keeps the value in memory and the next one mints another */
    }
};

export const clientIdFor = (automationId: string): string => {
    const name = key(automationId);
    const existing = read(name);
    if (existing !== undefined && existing !== "") {
        return existing;
    }
    const minted = crypto.randomUUID();
    write(name, minted);
    return minted;
};
