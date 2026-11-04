import type { SandboxMode } from "@intentic/constants";
import { useTheme } from "@intentic/ui";
import { embedded } from "../../../app/environments/nativeApp";
import { useSkin } from "../../../skins/useSkin";
import { themeRowLook } from "../../../skins/themeRow";

// THE LOOK A FIRST HANDS-OFF SANDBOX BRINGS. The look is the person's own and travels with their account; what the
// app paints for somebody who never chose one is the system's light or dark, which for a dark machine is the deep
// Sanctum skin. That suits someone who came to read code and not someone who came to have it handled, so a person whose
// first sandbox is made hands-off, and who has never touched the look, is given the plain light one once, here. It is an
// ordinary choice from then on: changed in Appearance like any other, and never applied over one the person made.
// (Before 2026-11 a link from intentic.dev/desk wrote it into the browser on arrival, whatever that person went on to do.)

/** Gives the light look to a person making their first sandbox hands-off who has never chosen a look. */
export const seedLookForHandsOff = (mode: SandboxMode, sandboxesBefore: number): void => {
    // Inside the Android app the look is the app's own, handed to this page; nothing here stores over it.
    if (mode !== `hands-off` || sandboxesBefore > 0 || embedded()) {
        return;
    }
    const theme = useTheme();
    const skin = useSkin();
    // `system` on both halves is the stored spelling of "nobody has chosen" (themeRow.ts).
    if (theme.choice.value !== `system` || skin.choice.value !== `system`) {
        return;
    }
    const look = themeRowLook(`light`);
    // The skin first, as the Theme row does: a pinned skin drags the scheme with it.
    skin.setSkin(look.skin);
    theme.set(look.scheme);
};
