import { readStored, storedId, writeStored } from "@intentic/sandbox-contract/embed";

// Visitor identity is a thread key (ephemeral, minted here) or, after sign-in, a Google ID token the daemon verifies. A
// typed display name is not identity; it rides as unverified `displayName`.

// Keys are namespaced per automation, so two Front Desks on one site are two threads and clearing one leaves the other
// signed in. Storage that refuses degrades to a fresh thread per load (embed helpers' rule).
const key = (automationId: string, name: string): string => `intentic.front-desk.${automationId}.${name}`;

// The visitor's thread id, minted once and kept; a follow-up message lands in the same conversation only when this
// does.
export const visitorConversationId = (automationId: string): string => storedId(key(automationId, "conversation"));

export const storedDisplayName = (automationId: string): string | undefined => readStored(key(automationId, "name"));
export const storeDisplayName = (automationId: string, name: string): void => writeStored(key(automationId, "name"), name);

// New chat: drops only the conversation id. A typed name and Google session belong to the person, not the thread.
export const resetConversation = (automationId: string): string => {
    const minted = crypto.randomUUID();
    writeStored(key(automationId, "conversation"), minted);
    return minted;
};

// Uses the site's own client id: GIS tokens are scoped to an authorized origin. Renders the button (not One Tap) into a
// light-DOM container; Google's iframe needs the real document.

interface GoogleIdentityServices {
    accounts: {
        id: {
            initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void;
            renderButton: (parent: HTMLElement, options: { theme: string; size: string; width?: number; text?: string }) => void;
        };
    };
}

const GIS_SRC = "https://accounts.google.com/gsi/client";

// One <script> tag per page and one load promise, however many Front Desks or sign-in opens.
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
        // Script already on the page may have already loaded; a `load` listener added now would never fire.
        if ((window as unknown as { google?: GoogleIdentityServices }).google !== undefined) {
            settle();
        }
    });
    return gisLoad;
};

export interface GoogleSignIn {
    readonly idToken: string;
}

// Renders Google's button into `container`, resolving with the ID token on sign-in; never resolves if they don't. The
// caller must keep the panel open and composer disabled meanwhile.
export const renderGoogleSignIn = async (container: HTMLElement, clientId: string): Promise<GoogleSignIn> => {
    const gis = await loadGis();
    return new Promise<GoogleSignIn>((resolve) => {
        gis.accounts.id.initialize({ client_id: clientId, callback: (response) => resolve({ idToken: response.credential }) });
        gis.accounts.id.renderButton(container, { theme: "outline", size: "large", text: "signin_with" });
    });
};
