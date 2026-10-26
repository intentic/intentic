import { computed, shallowRef } from "vue";

// The browser's offer to install Intentic as an app window of its own (Chromium's `beforeinstallprompt`, the manifest
// in public/manifest.webmanifest), kept from the moment it fires so a press later can raise it. An installed window is
// where a Mac gets ⌘W, ⌘⇧T and ⌘⇧] (windowKind.ts), so the Keyboard page and the shortcut sheet offer it there.

interface InstallOffer extends Event {
    readonly prompt: () => Promise<void>;
    readonly userChoice: Promise<{ readonly outcome: `accepted` | `dismissed` }>;
}

const isInstallOffer = (event: Event): event is InstallOffer => `prompt` in event && typeof event.prompt === `function`;

// allow(module-state): the one offer a page load gets, held for whichever surface asks first
const offer = shallowRef<InstallOffer | undefined>(undefined);

/** Whether the browser will install this app if asked now. */
export const installOffered = computed(() => offer.value !== undefined);

/** Listens for the offer from boot; the event fires once, early, and is gone for a listener added later. */
export const installAppOffer = (): void => {
    window.addEventListener(`beforeinstallprompt`, (event) => {
        if (!isInstallOffer(event)) {
            return;
        }
        // Kept for a press of our own on a desktop; a phone keeps the browser's own banner.
        if (globalThis.matchMedia?.(`(pointer: fine)`).matches === true) {
            event.preventDefault();
        }
        offer.value = event;
    });
    window.addEventListener(`appinstalled`, () => {
        offer.value = undefined;
    });
};

/** Raises the browser's install dialog; true once the person accepted. The offer is spent either way. */
export const installApp = async (): Promise<boolean> => {
    const pending = offer.value;
    if (pending === undefined) {
        return false;
    }
    offer.value = undefined;
    await pending.prompt();
    return (await pending.userChoice).outcome === `accepted`;
};
