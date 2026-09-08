import { originPattern, siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "./tab-access.js";

// Lists every open tab. A tab's URL and title come from Chrome only for origins this extension holds permission
// for, so ungranted tabs show as present but unnamed, not hidden — and the full list still lets the agent target an
// already-open tab instead of opening a new one.

export const listTabs = async (): Promise<string> => {
    const [tabs, grants, paused] = await Promise.all([chrome.tabs.query({}), currentGrants(), store.paused()]);
    const modes = new Map(grants.map((grant) => [grant.origin, grant.mode]));
    const rows = tabs.map((tab) => {
        const pattern = originPattern(tab.url);
        const mode = pattern === undefined ? undefined : modes.get(pattern);
        const marker = tab.active === true ? `*` : ` `;
        return tab.url === undefined
            ? `${marker} [${tab.id ?? "?"}] (a page you have not allowed this browser to show the agent)`
            : `${marker} [${tab.id ?? "?"}] "${tab.title ?? ""}" ${tab.url} — ${mode === "act" ? "read and act" : "read only"}`;
    });
    return [
        paused ? `PAUSED: every tool refuses until the owner resumes the agent in their extension.` : ``,
        `${tabs.length} tab${tabs.length === 1 ? "" : "s"} open (* is the one in front):`,
        ...rows,
        ``,
        `Sites you have not been allowed on are listed without their address. Use ask_access to ask for one.`,
    ]
        .filter((line) => line !== ``)
        .join("\n");
};

// Brings a tab to front; allowed for any tab since switching isn't reading. Names the site only if the agent is
// allowed to see it.
export const selectTab = async (id: number): Promise<string> => {
    const tab = await chrome.tabs.update(id, { active: true }).catch(() => undefined);
    if (tab === undefined) {
        return `There is no tab ${id} in this browser any more. List the tabs again.`;
    }
    return tab.url === undefined
        ? `Switched to tab ${id}. It is a page you have not been allowed on: ask_access if you need to work there.`
        : `Switched to tab ${id}: ${siteOf(tab.url)}. Take a snapshot to see it.`;
};
