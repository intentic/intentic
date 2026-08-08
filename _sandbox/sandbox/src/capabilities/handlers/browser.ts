import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserConfig } from "@intentic/sandbox-contract";
import { BROWSER_TOOLS_NOTE } from "../../browser/browser-skill.js";
import { clearSession, hasSession } from "../../browser/session-store.js";
import { packFragment } from "../../environment/packs.js";
import type { CapabilityHandler } from "../capability.js";
import { browserUrls, contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// A browser-automation connector: give the AGENT a real, logged-in browser for one platform whose API can't
// cover "all the actions". The PLATFORM is data in an installed extension's `contributes.capabilities` (its card,
// its login URL, its cheatsheet); this handler is the generic plumbing over it. `apply` renders the platform's
// SKILL.md into .claude/skills/<id> (auto-loaded by the agent's settingSources) and its `fragment` is the
// browser feature pack — Chromium + Xvfb as one unit (packs/browser.Dockerfile), nothing when the running base
// image already bakes it (the standard image does; a core image rides it through an owner rebuild).
// The login itself happens out-of-band over the /system/browser-profile
// WebSocket, which persists a Chromium profile under .intentic/browser/<id>; the agent's @playwright/mcp
// (wired in agent.routes) reads that profile so it's already signed in, and the owner can reopen that same
// profile by hand on the same route. Distinct from `cli` (env credential + curl) — here the credential is a
// browser session, not an env var.
//
// ONE ENTRY IS ONE ACCOUNT, not one site: several entries may name the same platform (reddit-work and
// reddit-personal), and everything that carries identity — the profile, the login, the passkey — is keyed by the
// entry's ID (session-store.ts), as this handler's skill file and the agent's tool prefix already are. So the
// status below asks whether THIS account signed in, and the removal takes only this account's session with it.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

// Is the browser pack actually present — Chromium at playwright's cache path AND Xvfb on PATH? The probe for
// the "rebuild pending" state between "add" and "rebuild" (on a core image the pack rides the overlay). Both
// halves checked because the pack installs them as one unit and a half-present browser is unusable: Chromium
// without Xvfb can only run headless (fingerprinted and blocked), Xvfb without Chromium has nothing to display.
const browserPackInstalled = (): boolean => {
    if (!existsSync("/usr/bin/Xvfb")) {
        return false;
    }
    try {
        return readdirSync("/root/.cache/ms-playwright").some((entry) => entry.startsWith("chromium-"));
    } catch {
        return false;
    }
};

// The site an account is on, as a person would say it — the host of wherever its browser opens. Used in the
// messages the reader sees, because for a GENERIC session the `platform` slug is the card ("website") and says
// nothing about which site was actually connected. Undefined for a value that isn't an http(s) URL at all, which
// is what the add rejects rather than storing.
const siteOf = (url: string): string | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
    } catch {
        return undefined;
    }
};

export const browserHandler: CapabilityHandler = {
    // The whole config, not just the platform: a browser card holds no secret (its credential is the profile on
    // disk), and a generic session's page and purpose are exactly what the card's row has to be able to show.
    echo: (config) => ({ ...(config as BrowserConfig) }),
    fragment: () => packFragment("browser"),
    apply: async function* (ctx, id, config) {
        const { platform } = config as BrowserConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("browser", platform));
        if (contribution === undefined) {
            throw new Error(`no browser platform "${platform}" — install the extension that declares it`);
        }
        /* WHERE THIS ACCOUNT'S BROWSER OPENS, settled HERE rather than when the login window is opened. A card
         * pins it or the form answers it, and "neither" is a real possibility for the generic session — so it is
         * caught at add-time, where the reader is still on the form that could fix it, instead of surfacing later
         * as a sign-in window that comes up blank. */
        const urls = browserUrls(contribution.spec, config as Record<string, string>);
        if (urls === undefined) {
            throw new Error(`"${platform}" needs a page to open — fill in the site's address`);
        }
        const site = siteOf(urls.homeUrl) ?? siteOf(urls.loginUrl);
        if (site === undefined) {
            throw new Error(`"${urls.homeUrl}" is not a web address — include https:// and the site's host`);
        }
        const skill = await contributedSkill(contribution, id, BROWSER_TOOLS_NOTE, config as Record<string, string>);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${platform}" has no readable skill file — reinstall it`);
        }
        await ctx.files.write(skillPath(ctx.workspace.root, id), skill);
        yield {
            kind: "log",
            message: `Connected "${id}" on ${site}. Rebuild the sandbox if prompted, then open "Log in" to sign in — the agent can then act as you there.`,
        };
    },
    // Two distinct pending states. The web UI (Capabilities.vue) routes the rebuild one to the Environment card
    // and the login one to the guided-login window — it distinguishes them by the word "rebuild" in the detail,
    // so keep that word in the rebuild detail (and out of the login detail).
    status: async (ctx, id) => {
        if ((await ctx.files.read(skillPath(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!browserPackInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, id)) {
            return { state: "pending", detail: "log in to connect your account" };
        }
        return { state: "active" };
    },
    remove: async (ctx, id) => {
        await ctx.files.remove(join(ctx.workspace.root, ".claude", "skills", id));
        await clearSession(ctx.workspace.root, id);
    },
};
