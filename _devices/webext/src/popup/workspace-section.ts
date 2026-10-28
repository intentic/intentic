import type { PopupState } from "../background/messages.js";
import type { Settings } from "../background/settings.js";
import { byId, h, send, show } from "./dom.js";

// The popup's "Where it works": whether the agent opens its pages in a window of its own, behind the person's
// (background/agent-window.ts), or in the tab in front of them, as it did before 2026-10-28. With its own window open,
// "Show its window" brings that window in front, the one way it comes forward besides a question the person chose to
// look at.

export const saveSettings = async (settings: Settings, change: Partial<Settings>, refresh: () => Promise<void>): Promise<void> => {
    await send({ type: "settings", settings: { ...settings, ...change } });
    await refresh();
};

const CHOICES = [
    ["own-window", "Its own window", "It opens pages in a window of its own, behind yours"],
    ["front-tab", "My tab", "It works in the tab in front of you, where you watch"],
] as const;

export const renderWorkspace = (state: PopupState, refresh: () => Promise<void>): void => {
    show(byId("workspace"), state.sandbox !== undefined);
    const group = byId("work-in");
    group.replaceChildren();
    for (const [workIn, label, title] of CHOICES) {
        const option = h("button", { text: label, title });
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-checked", String(state.settings.workIn === workIn));
        option.addEventListener("click", () => {
            if (state.settings.workIn !== workIn) {
                void saveSettings(state.settings, { workIn }, refresh);
            }
        });
        group.append(option);
    }
    const own = state.settings.workIn === "own-window";
    byId("work-hint").textContent = own
        ? "It opens behind your windows, so the tab you are using is never taken over. Move its window to a spare screen to watch it work."
        : "It works in the tab in front of you, and opens pages there, so you see every step.";
    show(byId("show-agent"), own && state.agentWindowOpen);
};

// Once, when the popup opens: the render above runs on every redraw.
export const wireWorkspace = (): void => {
    byId<HTMLButtonElement>("show-agent").addEventListener("click", () => void send({ type: "show" }));
};
