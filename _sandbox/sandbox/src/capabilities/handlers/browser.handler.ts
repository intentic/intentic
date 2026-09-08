import { existsSync, readdirSync } from "node:fs";
import type { BrowserConfig } from "@intentic/sandbox-contract";
import { clearMarker, clearSession, hasSession, moveMarker, moveSession } from "../../browser/sessions/session-store.js";
import { packFragment } from "../../environment/packs.js";
import { loadedSkillFile } from "../../settings/loaded-skills.js";
import { accountGroupOf, accountSkillNames, convergeAccountSkills } from "../account-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { browserUrls, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// Browser-automation connector: platform data (card, login, skill) comes from an installed extension's manifest; this
// is generic plumbing over it. One entry is one account, not one site: several entries may share a platform, and
// profile/login/passkeys key off the entry's id. Login lands in a Chromium profile at .intentic/local/browser/<id>.

// True only if the whole browser pack (Chromium, Xvfb, ffmpeg, xdotool) is present: a half-present pack is unusable,
// not merely reduced. Exported for the identity handler, which shares this machinery.
export const browserPackInstalled = (): boolean => {
    if (!["/usr/bin/Xvfb", "/usr/bin/ffmpeg", "/usr/bin/xdotool"].every((tool) => existsSync(tool))) {
        return false;
    }
    try {
        return readdirSync("/root/.cache/ms-playwright").some((entry) => entry.startsWith("chromium-"));
    } catch {
        return false;
    }
};

// The site an account is on, for messages: a generic session's `platform` is just "website" and names nothing.
// Undefined for anything that is not an http(s) URL.
const siteOf = (url: string): string | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
    } catch {
        return undefined;
    }
};

export const browserHandler: CapabilityHandler = {
    // The stored password: what the daemon types into the site for the agent, and what /secrets rotates. Unset if the
    // profile was signed in by hand.
    secret: (config) => ((config as BrowserConfig).password !== undefined ? "password" : undefined),
    // The config minus the password (masked to `hasPassword`): a card's row shows the page and purpose, never the
    // credential.
    echo: (config) => {
        const { password, ...rest } = config as BrowserConfig;
        return {
            ...(Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(password !== undefined ? { hasPassword: true } : {}),
        };
    },
    fragment: () => packFragment("browser"),
    // The marker always moves with the entry; the profile and its passkeys move only for a standalone account, the one
    // that owns them. Same split as `remove`.
    rename: {
        carry: async (ctx, from, to, config) => {
            await ((config as BrowserConfig).identity === undefined ? moveSession : moveMarker)(ctx.workspace.root, from, to);
        },
    },
    async *apply(ctx, id, config) {
        const { platform, identity } = config as BrowserConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("browser", platform));
        if (contribution === undefined) {
            throw new Error(`no browser platform "${platform}": install the extension that declares it`);
        }
        // Which identity owns this browser, resolved now rather than surfacing later as tools over an empty profile.
        const born = identity === undefined ? undefined : await ctx.capabilities.get(identity);
        if (identity !== undefined && born?.kind !== "identity") {
            throw new Error(`no identity "${identity}": add the identity first, or leave the field empty for a standalone account`);
        }
        // Where this account opens, resolved at add-time, not when the login window opens, so it fails here.
        const urls = browserUrls(contribution.spec, config as Record<string, string>);
        if (urls === undefined) {
            throw new Error(`"${platform}" needs a page to open: fill in the site's address`);
        }
        const site = siteOf(urls.homeUrl) ?? siteOf(urls.loginUrl);
        if (site === undefined) {
            throw new Error(`"${urls.homeUrl}" is not a web address: include https:// and the site's host`);
        }
        if (!("skill" in contribution.spec)) {
            throw new Error(`the extension declaring "${platform}" has no readable skill file: reinstall it`);
        }
        // The route upserts after apply; this entry rides in as the delta before the store records it.
        await convergeAccountSkills(ctx, { upsert: { id, kind: "browser", config: config as BrowserConfig } });
        yield {
            kind: "log",
            message:
                born === undefined
                    ? `Connected "${id}" on ${site}. Rebuild the sandbox if prompted, then open "Log in" to sign in, or ask the agent to sign in (or sign up) for you. Once connected, the agent acts as you there.`
                    : `Filed "${id}" on ${site} under the identity "${born.id}", it shares that identity's browser. Ask the agent to sign in (or sign up) through it, or open "Log in" to do it yourself.`,
        };
    },
    // Two pending states, told apart by the word "rebuild" in `detail`: the UI routes on it to the Environment card or
    // the login window. Keep the word in one, out of the other.
    status: async (ctx, id, config) => {
        const group = accountGroupOf(config as BrowserConfig);
        if (!accountSkillNames(await ctx.files.read(loadedSkillFile(ctx.workspace.root, group.name)), id)) {
            return { state: "inactive" };
        }
        if (!browserPackInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, id)) {
            return { state: "pending", detail: "log in to connect your account, or ask the agent to sign in for you" };
        }
        return { state: "active" };
    },
    // A standalone account's removal takes its whole profile; an identity-born account's takes only its marker and
    // roster line. The shared browser outlives any one account.
    remove: async (ctx, id, config) => {
        // The route deletes the entry after this hook runs; told here to omit it up front.
        await convergeAccountSkills(ctx, { omit: id });
        if ((config as BrowserConfig).identity === undefined) {
            await clearSession(ctx.workspace.root, id);
        } else {
            await clearMarker(ctx.workspace.root, id);
        }
    },
};
