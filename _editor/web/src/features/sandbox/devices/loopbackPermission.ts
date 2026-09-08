// What the browser says about reaching this machine (Chrome's Local Network Access). Read from the browser
// rather than assumed: `ungated` is a real answer meaning nothing gates the reach. Every failure here also
// answers `ungated`, since refusing a working address is worse than an unexplained dialog. The card is for
// `prompt` alone.

export type LoopbackPermission = "granted" | "denied" | "prompt" | "ungated";

// Chrome 145 split `local-network-access` into `local-network` (LAN) and `loopback-network` (this machine);
// only 127.0.0.1 is ever dialed, so the narrow name is asked first, with the old one as fallback for 142-144.
const NAMES = [`loopback-network`, `local-network-access`];

// The live `PermissionStatus`, kept rather than its state: it updates in place on a site-settings change, so
// holding it makes a revoke visible without polling. One query per document.
let asked: Promise<PermissionStatus | undefined> | undefined;

const query = async (): Promise<PermissionStatus | undefined> => {
    const permissions = globalThis.navigator?.permissions as Permissions | undefined;
    if (permissions === undefined) {
        return undefined;
    }
    for (const name of NAMES) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- the second name is only worth asking about once the first has been refused as unknown
            return await permissions.query({ name } as unknown as PermissionDescriptor);
        } catch {
            // An unknown name rejects: this browser calls the permission something else, or has none.
        }
    }
    return undefined;
};

// Reads the Tauri-injected marker directly rather than through environment.ts, which throws under the
// windowless vitest `node` environment several suites use via useEndpoint's import chain.
const desktopWebview = (): Window["__INTENTIC_DESKTOP__"] => (typeof window === `undefined` ? undefined : window.__INTENTIC_DESKTOP__);

// The desktop app answers before Chrome is asked: its workspace webview disables the check at install time
// (WebKit on macOS/Linux never had it), read from a flag so an older, still-enforcing webview gets the card.
export const loopbackPermission = async (): Promise<LoopbackPermission> => {
    if (desktopWebview()?.loopbackUngated === true) {
        return `ungated`;
    }
    asked ??= query();
    const status = await asked;
    return status?.state ?? `ungated`;
};
