import type { PopupState } from "../background/messages.js";
import type { Settings } from "../background/settings.js";
import { byId, h, send, show } from "./dom.js";

// The popup's "Where it works": whether the agent opens its pages in a window of its own, behind the person's
// (background/agent-window.ts), or in the tab in front of them, as it did before 2026-10-28. Each sandbox's agent has a
// window of its own, and its row under "Sandboxes" (sandboxes-section.ts) is where "Show its window" brings it in front.

export const saveSettings = async (settings: Settings, change: Partial<Settings>, refresh: () => Promise<void>): Promise<void> => {
    await send({ type: "settings", settings: { ...settings, ...change } });
    await refresh();
};

const CHOICES = [
    ["own-window", "Its own window", "It opens pages in a window of its own, behind yours"],
    ["front-tab", "My tab", "It works in the tab in front of you, where you watch"],
] as const;

export const renderWorkspace = (state: PopupState, refresh: () => Promise<void>): void => {
    show(byId("workspace"), state.sandboxes.length > 0);
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
    const several = state.sandboxes.length > 1;
    byId("work-hint").textContent = own
        ? several
            ? "Each sandbox's agent opens a window of its own behind yours, so the tab you are using is never taken over. Move one to a spare screen to watch it work."
            : "It opens behind your windows, so the tab you are using is never taken over. Move its window to a spare screen to watch it work."
        : several
          ? "They work in the tab in front of you, and open pages there, so you see every step. With several sandboxes at work, one may move the tab another is on."
          : "It works in the tab in front of you, and opens pages there, so you see every step.";
};
