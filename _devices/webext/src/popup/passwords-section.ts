import type { PopupState } from "../background/messages.js";
import { button, byId, say, send, show } from "./dom.js";

// The popup's Passwords section: remembering and filling sign-ins in this browser, turned on with one click that asks
// the browser for native messaging and every site (both at once, while the click still counts as the person's), then
// tells the worker to reach Passwords on this computer. Kept apart from the agent's sections above it: none of what is
// granted here is a site the agent may work on.

export const renderPasswords = (state: PopupState, refresh: () => Promise<void>): void => {
    const lead = byId("passwords-lead");
    const detail = byId("passwords-detail");
    const actions = byId("passwords-actions");
    const error = byId("passwords-error");
    say(error, undefined);
    actions.replaceChildren();
    const pw = state.passwords;
    switch (pw.kind) {
        case "off":
            lead.textContent = "Remember and fill passwords with Intentic";
            show(detail, false);
            actions.append(
                button("Turn on", "primary", () => {
                    void (async () => {
                        const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"], origins: ["<all_urls>"] });
                        if (!granted) {
                            say(error, "The browser did not allow access, so nothing changed.");
                            return;
                        }
                        const result = await send<{ ok: boolean; message?: string }>({ type: "passwords-enable" });
                        if (!result.ok) {
                            say(error, result.message ?? "Could not connect to Passwords on this computer.");
                        }
                        await refresh();
                    })();
                }),
            );
            break;
        case "missing-host":
            lead.textContent = "Remember and fill passwords with Intentic";
            detail.textContent = pw.message;
            show(detail, true);
            break;
        case "remember-off":
            lead.textContent = "Remember and fill passwords with Intentic";
            detail.textContent = "Turned off in Passwords on this computer";
            show(detail, true);
            break;
        case "locked":
            lead.textContent = "Passwords is locked on this computer";
            detail.textContent = "Unlock Passwords on this computer, then try again.";
            show(detail, true);
            break;
        case "on":
            lead.textContent = "Remembering and filling passwords in this browser";
            detail.textContent = `Connected to Passwords on this computer.`;
            show(detail, true);
            break;
    }
};
