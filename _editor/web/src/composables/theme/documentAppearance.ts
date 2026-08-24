import { useTextSize } from "@intentic/ui/text-size";
import { useTheme } from "@intentic/ui/theme";
import { useSkin } from "../../skins/useSkin";
import { useImportedTheme } from "./useImportedTheme";

/* THE FOUR PREFERENCES THAT PAINT THE DOCUMENT, INSTALLED IN EVERY WINDOW.
 *
 * Most preferences are read by the surface they govern, so the window drawing that surface is the window whose
 * import graph reaches them, and nothing more is needed. These four are different: they are attributes and
 * inline custom properties on <html>, they apply to everything at once, and they are applied by their own
 * module's load. So in a window that never imports one, the setting is not merely un-synced, it is never applied
 * at all, and there is no surface whose absence would give it away.
 *
 * WHICH IS EXACTLY WHAT HAPPENED TO THE SKIN. `useSkin` was imported by the settings page and nothing else, so a
 * popped-out chat (/floating/chat, a whole other window of the app, see composables/floating.ts) never loaded it.
 * The window still LOOKED right on the way out, because index.html's anti-flash script writes `data-skin` from
 * storage on every load, so the CSS matched, and then never changed again for the life of the window: no
 * declaration meant nothing registered to hear the change (composables/preference.ts). Two things were wrong
 * underneath one symptom, and the second was invisible in the main window too: `applyFont` is the skin's, so the
 * face a skin asks for was missing until somebody opened /settings/appearance, in ANY window, on every load.
 * An imported VSCode theme had the same shape, reachable only from that page and from `useMonaco`, which a chat
 * window has no reason to load.
 *
 * So the guarantee is moved off the import graph and stated once, here, called from main.ts before the mount.
 * A preference that paints <html> belongs in this list; one read by a surface does not need to be.
 *
 * Ordering is the layering the two colour tiers already have: the accent writes the primitive RAMPS and an
 * imported theme overrides the chrome tokens on top of them, so it is installed last and still wins. */
export const installDocumentAppearance = (): void => {
    // The call IS the install: each composable's module applies the stored value to this document and registers
    // the preference to hear later changes, both at import time. Naming them here is what makes that happen in
    // every window rather than in whichever ones happened to route somewhere that wanted them.
    useTheme();
    useTextSize();
    useSkin();
    useImportedTheme();
};
