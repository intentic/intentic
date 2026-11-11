// What the sandbox trusts about Microsoft's identity platform, for the two exchanges it makes there itself: a card's
// connection test (probe-oauth.ts) and a form's device-code sign-in (device-sign-in.ts). Each of Microsoft's clouds pairs
// one sign-in host with one Graph host, so a token minted in one cloud is only ever sent to that cloud's Graph.
const MICROSOFT_CLOUDS: ReadonlyMap<string, string> = new Map([
    ["login.microsoftonline.com", "graph.microsoft.com"],
    ["login.microsoftonline.us", "graph.microsoft.us"],
    ["login.chinacloudapi.cn", "microsoftgraph.chinacloudapi.cn"],
]);

const WORLDWIDE_GRAPH = "https://graph.microsoft.com/";

export interface MicrosoftEndpoint {
    readonly url: URL;
    // The Graph host of the endpoint's cloud.
    readonly graph: string;
}

// A sign-in endpoint on one of the clouds: https, a known host, and nothing else in its authority. Undefined otherwise,
// before anything is sent.
export const microsoftEndpoint = (raw: string): MicrosoftEndpoint | undefined => {
    const url = URL.parse(raw);
    const graph = url === null ? undefined : MICROSOFT_CLOUDS.get(url.hostname);
    if (url === null || graph === undefined || url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
        return undefined;
    }
    return { url, graph };
};

// A Graph permission written for the worldwide cloud is asked of the Graph paired with the sign-in's own cloud, as the
// connection test's request is: a card declares its scopes once, not once per cloud.
export const scopeForCloud = (scope: string, graph: string): string =>
    scope
        .split(/\s+/u)
        .filter((part) => part !== "")
        .map((part) => (part.startsWith(WORLDWIDE_GRAPH) ? `https://${graph}/${part.slice(WORLDWIDE_GRAPH.length)}` : part))
        .join(" ");

// Where Microsoft sends a person to type a device code: its own short pages, or a page on the sign-in host itself (the
// national clouds). Anything else in an answer is not shown to anyone, since that page is opened in the owner's browser.
const VERIFICATION_HOSTS = new Set(["microsoft.com", "www.microsoft.com", "login.microsoft.com"]);

export const microsoftVerificationPage = (raw: string, authority: string): string | undefined => {
    const page = URL.parse(raw);
    if (page === null || page.protocol !== "https:" || page.port !== "" || page.username !== "" || page.password !== "") {
        return undefined;
    }
    return VERIFICATION_HOSTS.has(page.hostname) || page.hostname === authority ? page.toString() : undefined;
};

// A granted permission by its short name (`Mail.Read`), with the protocol's own sign-in scopes left out: what the
// person reads as what they allowed.
const SIGN_IN_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

export const grantedPermissions = (scope: string): string[] => [
    ...new Set(
        scope
            .split(/\s+/u)
            .filter((part) => part !== "" && !SIGN_IN_SCOPES.has(part.toLowerCase()))
            .map((part) => part.slice(part.lastIndexOf("/") + 1)),
    ),
];
