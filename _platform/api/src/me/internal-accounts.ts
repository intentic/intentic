/* THE TEAM'S OWN ACCOUNTS (2026-11-23). An account is internal when its address is an operator's (ADMIN_EMAILS), the
 * hosted canary's (HOSTED_CANARY_EMAIL), or on TELEMETRY_INTERNAL_ACCOUNTS, which lists further addresses and whole
 * domains (`@example.com`) for test accounts. Two readers: `/me` answers the signed-in account's own `internal`, so the
 * editor and the desktop app tag that account's analytics `internal: true`; and the admin funnel leaves these accounts
 * out by default. The list itself never leaves the server. Deployment config rather than a column, like ADMIN_EMAILS:
 * the people it names are the deployment's, and a flag in the database would need an admin action to keep it true. */

// The three lists it reads (config.ts), and nothing else of the deployment's config.
interface InternalConfig {
    readonly admin: { readonly emails: string };
    readonly hosted: { readonly canaryEmail: string };
    readonly telemetry: { readonly internalAccounts: string };
}

const entriesOf = (list: string): string[] =>
    list
        .split(`,`)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

/** Whether an address belongs to the team, by the deployment's lists. Case-insensitive; `@domain` matches the domain exactly. */
export const internalAccountMatcher = (config: InternalConfig): ((email: string) => boolean) => {
    const addresses = new Set([...entriesOf(config.admin.emails), ...entriesOf(config.hosted.canaryEmail)]);
    const domains = new Set<string>();
    for (const entry of entriesOf(config.telemetry.internalAccounts)) {
        if (entry.startsWith(`@`)) {
            if (entry.length > 1) {
                domains.add(entry.slice(1));
            }
        } else {
            addresses.add(entry);
        }
    }
    return (email) => {
        const address = email.trim().toLowerCase();
        if (addresses.has(address)) {
            return true;
        }
        const at = address.lastIndexOf(`@`);
        return at >= 0 && domains.has(address.slice(at + 1));
    };
};

/** The signed-in account's own answer: is this address one of the team's. */
export const isInternalAccount = (config: InternalConfig, email: string): boolean => internalAccountMatcher(config)(email);
