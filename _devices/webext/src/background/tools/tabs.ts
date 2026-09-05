import { originPattern, siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "./tab-access.js";

/* WHAT IS OPEN IN THIS BROWSER — and, for most of it, only that.
 *
 * A tab's URL and title arrive from Chrome ONLY for origins this extension holds a permission for. That is not
 * a limitation to work around: it is the property that makes this connector safe to install. Somebody who
 * allows the agent on their Jira does not thereby show it the other eleven tabs, and this listing says so in
 * as many words rather than presenting a suspicious row of blanks.
 *
 * The listing is still worth having in full: knowing that seven tabs exist and one of them is allowed is what
 * lets an agent say "I can work in your Jira tab" instead of opening an eighth. */

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

// Bring a tab to the front. Allowed for any tab — switching tabs is not reading one — and the answer says
// which site it landed on only when that is a site the agent may see.
export const selectTab = async (id: number): Promise<string> => {
    const tab = await chrome.tabs.update(id, { active: true }).catch(() => undefined);
    if (tab === undefined) {
        return `There is no tab ${id} in this browser any more. List the tabs again.`;
    }
    return tab.url === undefined
        ? `Switched to tab ${id}. It is a page you have not been allowed on: ask_access if you need to work there.`
        : `Switched to tab ${id}: ${siteOf(tab.url)}. Take a snapshot to see it.`;
};
