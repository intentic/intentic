import { originPattern, sandboxOwnOrigin, siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "./tab-access.js";

// Lists every open tab. Ungranted tabs show as present but unnamed, not hidden — the full list still lets the agent
// target an already-open tab instead of opening a new one. Chrome redacts a tab's URL for origins this extension
// holds no permission for, but not always: the popup's `activeTab` reveals the tab in front for as long as it stays
// on that page, so the name is kept or withheld by the grant list here, never by what Chrome happened to hand over.

export const listTabs = async (): Promise<string> => {
    const [tabs, grants, paused, sandbox] = await Promise.all([chrome.tabs.query({}), currentGrants(), store.paused(), store.sandbox()]);
    const modes = new Map(grants.map((grant) => [grant.origin, grant.mode]));
    const own = sandboxOwnOrigin(sandbox?.url);
    const rows = tabs.map((tab) => {
        const pattern = originPattern(tab.url);
        const mode = pattern === undefined ? undefined : modes.get(pattern);
        const marker = tab.active === true ? `*` : ` `;
        if (pattern !== undefined && pattern === own) {
            return `${marker} [${tab.id ?? "?"}] (the sandbox's own app, never a page to work on)`;
        }
        return mode === undefined
            ? `${marker} [${tab.id ?? "?"}] (a page you have not allowed this browser to show the agent)`
            : `${marker} [${tab.id ?? "?"}] "${tab.title ?? ""}" ${tab.url ?? ""} — ${mode === "act" ? "read and act" : "read only"}`;
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
    const pattern = originPattern(tab.url);
    const allowed = pattern !== undefined && (await currentGrants()).some((grant) => grant.origin === pattern);
    return allowed && tab.url !== undefined
        ? `Switched to tab ${id}: ${siteOf(tab.url)}. Take a snapshot to see it.`
        : `Switched to tab ${id}. It is a page you have not been allowed on: ask_access if you need to work there.`;
};
