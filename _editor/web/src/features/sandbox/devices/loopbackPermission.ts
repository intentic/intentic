/* WHAT THE BROWSER SAYS ABOUT REACHING THIS MACHINE — the other half of the question localShortcut.ts asks the
 * user, and the half that used to be guessed.
 *
 * Chrome 142 shipped Local Network Access: a request from a public origin to loopback needs a permission, and
 * the browser raises its own dialog to collect it. The app's card exists to explain that dialog before it
 * arrives (localShortcut.ts). What the app never did was ASK CHROME FIRST, so it kept its own yes in
 * localStorage and treated that as the state of a permission it does not own. Three things fell out of that,
 * all of them the same mistake in different clothes:
 *
 *   • A browser with no such permission — WebKit and Firefox implement none of this — was shown a card
 *     promising a dialog that was never going to appear, to buy a reach it already had.
 *   • A grant Chrome already holds (the second sandbox, the second window, a profile an administrator
 *     pre-granted with `LocalNetworkAccessAllowedForUrls`) was asked for again.
 *   • A grant REVOKED in Chrome's site settings left our `yes` behind, so the app went on probing an address
 *     the browser now refuses, and read the refusal as a sandbox that had moved.
 *
 * So the permission is read from the browser, and `ungated` is a real answer rather than an absent one: it
 * means nothing stands between this page and loopback, which is the state every browser was in before Chrome
 * 142 and the state most of them are still in. The card is for `prompt` alone.
 *
 * IT IS NEVER AN ERROR PATH. Every failure here — no Permissions API, a name this browser does not know, a
 * query that rejects for a reason we cannot name — answers `ungated`, because the alternative is refusing to
 * use an address that works on the strength of not having been able to ask about it. The cost of being wrong
 * is the unexplained dialog the card exists to prevent, in a browser that both implements the permission and
 * refuses to describe it; the cost of the other default is the shortcut silently never happening. */

export type LoopbackPermission = "granted" | "denied" | "prompt" | "ungated";

/* Chrome 145 split `local-network-access` in two: `local-network` for the LAN, `loopback-network` for this
 * machine. We only ever dial 127.0.0.1, so the narrow one is the one to ask about — asking under the old name
 * would report on a permission covering the user's whole network, which this app has never wanted and must not
 * imply it has. The old name stays as an alias and is all a Chrome 142–144 knows, so it is the fallback, and
 * an unknown name is how a browser without any of this is recognised. */
const NAMES = [`loopback-network`, `local-network-access`];

/* The live `PermissionStatus`, kept rather than its state: the object updates in place when the user changes
 * the grant in site settings, so holding it is what makes a revoke visible to the next probe without anything
 * having to watch for it. One query per document — this is asked on every reconnect. */
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
            // An unknown name rejects. Either this browser calls the permission something else, or it has none.
        }
    }
    return undefined;
};

/* The desktop app's own word about the webview this page is standing in, read off the marker its Tauri
 * initialization script injects rather than through `app/environments/desktop.ts`.
 *
 * THAT IS THE POINT OF THE DUPLICATION AND IT IS NOT AN OVERSIGHT. This module is reached from `resolve`
 * (useEndpoint.ts), which the daemon client pulls in, which several suites exercise under vitest's `node`
 * environment — and `desktop.ts` imports `environment.ts`, which reads `window.env` at module scope and throws
 * where there is no window. Importing the accessor for one boolean would drag that whole chain into every one
 * of them. The type is ambient (declared in `desktop.ts`), so only the read is repeated, not the shape.
 *
 * `typeof window` rather than a truthiness check, for the same reason: under `node` the identifier is not
 * merely undefined, it is undeclared. */
const desktopWebview = (): Window["__INTENTIC_DESKTOP__"] => (typeof window === `undefined` ? undefined : window.__INTENTIC_DESKTOP__);

/* Whether this page needs the user's permission before it dials loopback, and whether it already has it.
 *
 * The desktop app answers before Chrome is asked, because there the question was settled at install time: its
 * workspace webview loads one origin and disables the check outright (desktop-app windows.rs), and on macOS and
 * Linux that webview is WebKit, which never had it. Reading the flag rather than assuming it of any desktop
 * build is what keeps an older app — one whose webview still enforces the check — on the card that explains the
 * dialog it is still going to show. */
export const loopbackPermission = async (): Promise<LoopbackPermission> => {
    if (desktopWebview()?.loopbackUngated === true) {
        return `ungated`;
    }
    asked ??= query();
    const status = await asked;
    return status?.state ?? `ungated`;
};
