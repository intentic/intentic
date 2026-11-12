import { errorMessage } from "@intentic/base/errors";
import type { PopupState } from "../background/messages.js";
import { byId, say, show } from "./dom.js";

// The popup's Downloads switch: the optional `downloads` permission, which lets a file the agent's own click downloads
// go into its sandbox instead of the person's Downloads folder (background/tools/media-downloads.ts). Optional rather
// than required because a new required permission makes Chrome disable the store-installed extension until the person
// approves it again. The switch is the browser's own permission, read fresh each time, so one removed in the browser's
// settings shows here as off.

const PERMISSION = { permissions: ["downloads"] };

let wired = false;

const reflect = async (input: HTMLInputElement): Promise<void> => {
    // allow(silent-catch): a browser that cannot say (the preview page) shows the switch off, which is what it is there
    input.checked = await chrome.permissions.contains(PERMISSION).catch(() => false);
};

export const renderDownloads = (state: PopupState): void => {
    show(byId("downloads"), state.sandboxes.length > 0);
    const input = byId<HTMLInputElement>("downloads-on");
    const error = byId("downloads-error");
    void reflect(input);
    if (wired) {
        return;
    }
    wired = true;
    input.addEventListener("change", () => {
        say(error, undefined);
        // Asked before any await, while the click still counts as the person's (popup.ts says why).
        const asked = input.checked ? chrome.permissions.request(PERMISSION) : chrome.permissions.remove(PERMISSION);
        void asked
            .then(async (changed) => {
                if (!changed && input.checked) {
                    say(error, "The browser did not allow it, so nothing changed.");
                }
                await reflect(input);
            })
            .catch((cause: Error) => say(error, errorMessage(cause)));
    });
};
