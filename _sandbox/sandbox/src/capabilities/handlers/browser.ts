import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserConfig } from "@intentic/sandbox-contract";
import { BROWSER_FRAGMENT, BROWSER_TOOLS_NOTE } from "../../browser/browser-skill.js";
import { clearSession, hasSession } from "../../browser/session-store.js";
import type { CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// A browser-automation connector: give the AGENT a real, logged-in browser for one platform whose API can't
// cover "all the actions". The PLATFORM is data in an installed extension's `contributes.capabilities` (its card,
// its login URL, its cheatsheet); this handler is the generic plumbing over it. `apply` renders the platform's
// SKILL.md into .claude/skills/<id> (auto-loaded by the agent's settingSources) and its `fragment` bakes Xvfb
// into the environment overlay (owner rebuild) — Chromium itself is baked in the base image (browser-skill.ts).
// The login itself happens out-of-band over the /system/browser-login
// WebSocket, which persists a Chromium profile under .intentic/browser/<platform>; the agent's @playwright/mcp
// (wired in agent.routes) reads that profile so it's already signed in. Distinct from `cli` (env credential +
// curl) — here the credential is a browser session, not an env var.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

// Is Xvfb actually present? Chromium is baked in the base image, so the display server is the only thing the
// fragment still installs on an owner rebuild — and therefore the probe for the "rebuild pending" state between
// "add" and "rebuild". The apt path, matching how the fragment installs it (display.ts spawns it from PATH).
const xvfbInstalled = (): boolean => existsSync("/usr/bin/Xvfb");

export const browserHandler: CapabilityHandler = {
    echo: (config) => ({ platform: (config as BrowserConfig).platform }),
    fragment: () => BROWSER_FRAGMENT,
    apply: async function* (ctx, id, config) {
        const { platform } = config as BrowserConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("browser", platform));
        if (contribution === undefined) {
            throw new Error(`no browser platform "${platform}" — install the extension that declares it`);
        }
        const skill = await contributedSkill(contribution, id, BROWSER_TOOLS_NOTE);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${platform}" has no readable skill file — reinstall it`);
        }
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
        if (!xvfbInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
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
