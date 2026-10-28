import { agentWindowOwner, isAgentWindow, ownWindow } from "../agent-window.js";
import { originPattern, siteOf } from "../policy.js";
import { type SandboxKey, store } from "../store.js";
import { currentGrants, sandboxOrigins } from "./tab-access.js";

// Lists every open tab. Ungranted tabs show as present but unnamed, not hidden — the full list still lets the agent
// target an already-open tab instead of opening a new one. Chrome redacts a tab's URL for origins this extension
// holds no permission for, but not always: the popup's `activeTab` reveals the tab in front for as long as it stays
// on that page, so the name is kept or withheld by the grant list here, never by what Chrome happened to hand over.

export const listTabs = async (from: SandboxKey): Promise<string> => {
    const [tabs, grants, paused, origins, own, windows] = await Promise.all([
        chrome.tabs.query({}),
        currentGrants(),
        store.paused(),
        sandboxOrigins(from),
        ownWindow(),
        store.agentWindows(),
    ]);
    const modes = new Map(grants.map((grant) => [grant.origin, grant.mode]));
    const agentWindowId = windows[from];
    // The windows other sandboxes' agents work in: neither this agent's nor the person's.
    const othersWindows = new Set(Object.entries(windows).flatMap(([key, id]) => (key === from ? [] : [id])));
    // What a tab is said to be: a sandbox's app is named as one, a page the agent may not see is not named at all.
    const shown = (tab: chrome.tabs.Tab, pattern: string | undefined): string => {
        if (pattern !== undefined && pattern === origins.own) {
            return `(the sandbox's own app, never a page to work on)`;
        }
        if (pattern !== undefined && origins.others.includes(pattern)) {
            return `(another of the person's sandboxes, never a page to work on)`;
        }
        const mode = pattern === undefined ? undefined : modes.get(pattern);
        return mode === undefined
            ? `(a page you have not allowed this browser to show the agent)`
            : `"${tab.title ?? ""}" ${tab.url ?? ""} — ${mode === "act" ? "read and act" : "read only"}`;
    };
    const row = (tab: chrome.tabs.Tab): string => `${tab.active === true ? `*` : ` `} [${tab.id ?? "?"}] ${shown(tab, originPattern(tab.url))}`;
    const count = `${tabs.length} tab${tabs.length === 1 ? "" : "s"} open`;
    // In its own window the agent's tabs and the person's are two lists, since only its own are ever brought forward.
    const mine = own ? tabs.filter((tab) => agentWindowId !== undefined && tab.windowId === agentWindowId) : [];
    const others = tabs.filter((tab) => !mine.includes(tab) && tab.windowId !== undefined && othersWindows.has(tab.windowId));
    const theirs = own ? tabs.filter((tab) => !mine.includes(tab) && !others.includes(tab)) : tabs.filter((tab) => !others.includes(tab));
    const listed = own
        ? [
              `${count}.`,
              mine.length === 0
                  ? `Your own window is not open: \`open\` makes one, behind the person's.`
                  : `Your own window, behind the person's (* is your tab, where tools given no \`tab\` work):`,
              ...mine.map(row),
              `The person's tabs (* is the one in front of each window; pass \`tab\` to work on one where it is, it is never brought forward):`,
              ...theirs.map(row),
          ]
        : [`${count} (* is the one in front):`, ...theirs.map(row)];
    // Another sandbox's agent at work in this same browser: its tabs are its own, and pointing one elsewhere would
    // break what it is doing.
    if (others.length > 0) {
        listed.push(`Another sandbox's agent works in these, in its own window (leave them to it):`, ...others.map(row));
    }
    return [
        paused ? `PAUSED: every tool refuses until the owner resumes the agent in their extension.` : ``,
        ...listed,
        ``,
        `Sites you have not been allowed on are listed without their address. Use ask_access to ask for one.`,
    ]
        .filter((line) => line !== ``)
        .join("\n");
};

// Brings a tab to front; allowed for any tab since switching isn't reading. Names the site only if the agent is
// allowed to see it. Working in its own window, the agent switches only among its own tabs: one of the person's is
// left where it is, since bringing it forward is taking over what they look at.
export const selectTab = async (id: number, from: SandboxKey): Promise<string> => {
    // allow(silent-catch): a tab that closed has nothing to switch to, which is what the answer below says
    const found = await chrome.tabs.get(id).catch(() => undefined);
    if (found === undefined) {
        return `There is no tab ${id} in this browser any more. List the tabs again.`;
    }
    const owner = await agentWindowOwner(found.windowId);
    if (owner !== undefined && owner !== from) {
        return `Tab ${id} is in another sandbox's agent window, where that agent is working. It was not brought to the front: leave it to that agent.`;
    }
    if ((await ownWindow()) && !(await isAgentWindow(found.windowId, from))) {
        return `Tab ${id} is one of the person's own tabs, so it was not brought to the front. Pass \`tab: ${id}\` to snapshot, read, click or fill to work on it where it is.`;
    }
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
