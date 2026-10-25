import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";

/* WHICH SIGNED-IN ACCOUNT A PAGE BELONGS TO.

   A turn holding the `x` account has three browsers it could point at x.com: the `browser` server with `account: "x"`,
   signed in; the `web` browser, signed into nothing; and the owner's own browser, behind a person's click. Only the
   first is right, and a weak model picks by name. 2026-10-25: one run navigated `web` to x.com, met the login wall,
   concluded the account was signed out, and asked the owner's Brave for x.com at 22:00; another went to the owner's
   browser straight from a roster that said `x · signed in`. The two wrong doors answer with the right one instead, and
   this is what they ask. */

// A page's host as accounts are matched on it: lowercased, `www.` dropped, a bare host read as https.
export const bareHost = (address: string): string | undefined => {
    try {
        const host = new URL(address.includes("://") ? address : `https://${address}`).hostname.toLowerCase();
        return host === "" ? undefined : host.replace(/^www\./, "");
    } catch {
        // allow(silent-catch): an address that does not parse names no host, and naming a host is all this is asked.
        return undefined;
    }
};

// Each granted account's site, host to account id: the hosts its sign-in and home pages are on. The first account to
// claim a host keeps it, so two accounts on one site name the one listed first, which is still a signed-in door.
export const accountHostsOf = async (
    granted: readonly Capability[],
    signInUrls: (capability: Capability) => Promise<readonly string[]>,
): Promise<Record<string, string>> => {
    const hosts: Record<string, string> = {};
    for (const capability of granted.filter((entry) => entry.kind === "browser")) {
        // Started inside the chain, so a lookup that throws before it returns is caught the same way.
        const urls = await Promise.resolve(capability)
            .then(signInUrls)
            // allow(silent-catch): a card whose extension is gone names no site, and a host it cannot name steers nothing.
            .catch(() => []);
        for (const host of urls.map(bareHost)) {
            if (host !== undefined && hosts[host] === undefined) {
                hosts[host] = capability.id;
            }
        }
    }
    return hosts;
};

// The account whose site this page is on: the host itself, or a subdomain of one (mobile.x.com is x.com's).
export const accountCovering = (
    hosts: Readonly<Record<string, string>>,
    address: string,
): { readonly account: string; readonly host: string } | undefined => {
    const host = bareHost(address);
    if (host === undefined) {
        return undefined;
    }
    const site = Object.entries(hosts).find(([known]) => host === known || host.endsWith(`.${known}`));
    return site === undefined ? undefined : { account: site[1], host: site[0] };
};

// The one sentence both wrong doors answer with: where the page should be opened, in the words every runtime's tool
// list can be matched against (the server, the tool, and the spelling most loops show).
export const signedInDoor = (account: string, host: string): string =>
    `${host} is signed in as the sandbox account \`${account}\`, which this turn holds. Open it in that account's own ` +
    `browser: the \`browser\` server's \`browser_navigate\` (\`mcp__browser__browser_navigate\` in most tool lists) with ` +
    `\`account: "${account}"\`, and pass the same \`account\` on every call after it. The \`web\` browser is signed into ` +
    `nothing, and the owner's own browser is theirs, for what no sandbox account covers. If the account's browser shows ` +
    `a login page, its session expired: call \`request_help\` on the \`accounts\` server, never switch browsers.`;
