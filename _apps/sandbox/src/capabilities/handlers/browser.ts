import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserConfig } from "@intentic/sandbox-contract";
import { BROWSER_FRAGMENT, browserProviders } from "../../browser/providers.js";
import { clearSession, hasSession } from "../../browser/session-store.js";
import type { CapabilityHandler } from "../capability.js";

// A browser-automation connector: give the AGENT a real, logged-in browser for one social platform (Reddit / X /
// YouTube) whose API can't cover "all the actions". `apply` drops the platform's SKILL.md into
// .claude/skills/<id> (auto-loaded by the agent's settingSources) and its `fragment` bakes Chromium into the
// environment overlay (owner rebuild). The login itself happens out-of-band over the /system/browser-login
// WebSocket, which persists a Chromium profile under .intentic/browser/<platform>; the agent's @playwright/mcp
// (wired in agent.routes) reads that profile so it's already signed in. Distinct from `cli` (env credential +
// curl) — here the credential is a browser session, not an env var.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

// Is Chromium actually present? The fragment installs it on an owner rebuild, so between "add" and "rebuild" the
// capability is pending. Dynamic import keeps heavy Playwright out of the daemon's boot path (only a browser
// capability's status probe loads it), and PLAYWRIGHT_BROWSERS_PATH (set by the fragment) points executablePath
// at the installed build.
const chromiumInstalled = async (): Promise<boolean> => {
    try {
        const { chromium } = await import("playwright");
        return existsSync(chromium.executablePath());
    } catch {
        return false;
    }
};

export const browserHandler: CapabilityHandler = {
    echo: (config) => ({ platform: (config as BrowserConfig).platform }),
    fragment: () => BROWSER_FRAGMENT,
    apply: async function* (ctx, id, config) {
        const { platform } = config as BrowserConfig;
        // Template the frontmatter name → the (unique) id so two instances never register the same skill name.
        const skill = browserProviders[platform].skill.replace(/^name: .*$/m, `name: ${id}`);
        await ctx.files.write(skillPath(ctx.workspace.root, id), skill);
        yield {
            kind: "log",
            message: `Connected the ${platform} browser. Rebuild the sandbox if prompted, then open "Log in" to sign in — the agent can then act as you on ${platform}.`,
        };
    },
    // Two distinct pending states. The web UI (Capabilities.vue) routes the rebuild one to the Environment card
    // and the login one to the guided-login window — it distinguishes them by the word "rebuild" in the detail,
    // so keep that word in the rebuild detail (and out of the login detail).
    status: async (ctx, id, config) => {
        if ((await ctx.files.read(skillPath(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await chromiumInstalled())) {
            return { state: "pending", detail: "rebuild the sandbox to install the browser (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, (config as BrowserConfig).platform)) {
            return { state: "pending", detail: "log in to connect your account" };
        }
        return { state: "active" };
    },
    remove: async (ctx, id, config) => {
        await ctx.files.remove(join(ctx.workspace.root, ".claude", "skills", id));
        await clearSession(ctx.workspace.root, (config as BrowserConfig).platform);
    },
};
