/* Who the visitor is, in the two forms the daemon distinguishes: a THREAD key (ephemeral, minted here, not a
 * claim about anybody) and, when the site asks for sign-in, a Google ID token the daemon verifies itself.
 *
 * The typed name is deliberately NOT part of identity, it rides the message as `displayName` and the daemon
 * hands it to the model tagged unverified. Anyone can type "admin"; only Google's signature says who someone is. */

// localStorage keys are namespaced per automation: two Front Desks on one site are two threads, and clearing one
// must not log the visitor out of the other.
const key = (automationId: string, name: string): string => `intentic.front-desk.${automationId}.${name}`;

// localStorage throws in Safari's private mode and wherever the site blocks storage. A visitor with no storage
// still gets a working chat, just a fresh thread per page load, which is the honest degradation.
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
        /* no storage, the caller keeps the value in memory for this page load */
    }
};

// The visitor's thread id, minted once and kept. This is what makes a follow-up message land in the SAME
// sandbox conversation instead of opening a new one, so it is the single most important thing to persist.
export const visitorConversationId = (automationId: string): string => {
    const name = key(automationId, "conversation");
    const existing = read(name);
    if (existing !== undefined && existing !== "") {
        return existing;
    }
    const minted = crypto.randomUUID();
    write(name, minted);
    return minted;
};

export const storedDisplayName = (automationId: string): string | undefined => read(key(automationId, "name"));
export const storeDisplayName = (automationId: string, name: string): void => write(key(automationId, "name"), name);

// Start a new thread, the visitor pressed "New chat". Only the conversation id is dropped; a typed name and a
// Google session are properties of the person, not of the thread.
export const resetConversation = (automationId: string): string => {
    const minted = crypto.randomUUID();
    write(key(automationId, "conversation"), minted);
    return minted;
};

/* ---- Google sign-in ----
 *
 * The site's OWN client id, never intentic's: Google Identity Services issues a token only to an authorized
 * JavaScript origin, and intentic's OAuth client cannot list every customer's domain. The daemon verifies the
 * resulting token against Google's JWKS with that same client id as the audience.
 *
 * The button is RENDERED (not One Tap): One Tap is unavailable in enough embedded contexts to be a support
 * burden, while renderButton only needs a container. That container is a light-DOM element the widget slots
 * into its panel, see element.ts, because Google's iframe belongs in the document, not in a shadow root. */

interface GoogleIdentityServices {
    accounts: {
        id: {
            initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void;
            renderButton: (parent: HTMLElement, options: { theme: string; size: string; width?: number; text?: string }) => void;
        };
    };
}

const GIS_SRC = "https://accounts.google.com/gsi/client";

// One <script> per page however many Front Desks are on it, and one promise however many times sign-in is opened.
let gisLoad: Promise<GoogleIdentityServices> | undefined;

const loadGis = async (): Promise<GoogleIdentityServices> => {
    gisLoad ??= new Promise<GoogleIdentityServices>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
        const script = existing ?? document.createElement("script");
        const settle = (): void => {
            const gis = (window as unknown as { google?: GoogleIdentityServices }).google;
            if (gis === undefined) {
                reject(new Error("Google sign-in failed to load"));
                return;
            }
            resolve(gis);
        };
        script.addEventListener("load", settle);
        script.addEventListener("error", () => reject(new Error("Google sign-in failed to load")));
        if (existing === null) {
            script.src = GIS_SRC;
            script.async = true;
            document.head.append(script);
            return;
        }
        // Already on the page and possibly already loaded, a `load` listener added after the fact never fires.
        if ((window as unknown as { google?: GoogleIdentityServices }).google !== undefined) {
            settle();
        }
    });
    return gisLoad;
};

export interface GoogleSignIn {
    readonly idToken: string;
}

// Render Google's button into `container` and resolve with the ID token once the visitor signs in. Never
// resolves if they don't, the caller keeps the panel open and the composer disabled, which is the whole point
// of an access-gated Front Desk.
export const renderGoogleSignIn = async (container: HTMLElement, clientId: string): Promise<GoogleSignIn> => {
    const gis = await loadGis();
    return new Promise<GoogleSignIn>((resolve) => {
        gis.accounts.id.initialize({ client_id: clientId, callback: (response) => resolve({ idToken: response.credential }) });
        gis.accounts.id.renderButton(container, { theme: "outline", size: "large", text: "signin_with" });
    });
};
