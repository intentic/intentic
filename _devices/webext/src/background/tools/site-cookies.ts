// What "this site's sign-in" means in both directions: session.ts hands it to the sandbox, lend.ts borrows one back.
// It is the cookies this browser sends to the site the tab is on, and never a neighbour's. Until 2026-11-24 both
// directions took every cookie under the host's last two labels, so allowing bbc.co.uk read every *.co.uk cookie
// (banks included) and foo.github.io read every other github.io site's. A public-suffix list was the alternative,
// rejected: Chrome already applies its own list in `getAll({ url })`.

// A cookie's domain without Chrome's leading dot (its "and subdomains" marker), for comparing with a host.
const bare = (domain: string): string => (domain.startsWith(".") ? domain.slice(1) : domain).toLowerCase();

// The cookies Chrome sends to `url`: host-only ones, the host's parent domains' and secure ones only over https, all
// matched by Chrome itself. Path-matching drops the host's own cookies kept on other paths (`/api`), so those are
// added back. Cookies for a subdomain or a sibling are never included.
export const siteCookies = async (url: string): Promise<chrome.cookies.Cookie[]> => {
    const host = new URL(url).hostname.toLowerCase();
    const [sent, hosts] = await Promise.all([chrome.cookies.getAll({ url }), chrome.cookies.getAll({ domain: host })]);
    const seen = new Set<string>();
    return [...sent, ...hosts.filter((cookie) => bare(cookie.domain) === host)].filter((cookie) => {
        const key = `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
        const fresh = !seen.has(key);
        seen.add(key);
        return fresh;
    });
};

// Whether a cookie a sandbox sends back may be written here: only for the host itself, or for a domain the site's own
// cookies in this browser already use (a sign-in kept on the parent domain). Any other cookie would sign this browser
// in somewhere the person never agreed to.
export const writableFor = (
    host: string,
    jar: readonly Pick<chrome.cookies.Cookie, "domain">[],
): ((cookie: { readonly domain: string }) => boolean) => {
    const own = host.toLowerCase();
    const used = new Set(jar.map((cookie) => cookie.domain.toLowerCase()));
    return (cookie) => bare(cookie.domain) === own || used.has(cookie.domain.toLowerCase());
};
