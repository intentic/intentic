import { useTextSize } from "@intentic/ui/text-size";
import { useTheme } from "@intentic/ui/theme";
import { useSkin } from "../../skins/useSkin";

// Preferences that paint <html> directly (theme, text size, skin): applied via each composable's module load, not by
// whichever surface happens to import them. Called once here, from main.ts before mount, so every window gets them
// regardless of import graph.
export const installDocumentAppearance = (): void => {
    // Each call installs and subscribes its composable to later changes at import time; naming them here guarantees
    // that happens in every window.
    useTheme();
    useTextSize();
    useSkin();
};
