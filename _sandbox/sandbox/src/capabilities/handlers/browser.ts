import { existsSync, readdirSync } from "node:fs";
import type { BrowserConfig, IdentityConfig } from "@intentic/sandbox-contract";
import { browserToolsNote } from "../../browser/browser-skill.js";
import { clearMarker, clearSession, hasSession, moveMarker, moveSession } from "../../browser/session-store.js";
import { packFragment } from "../../environment/packs.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { browserUrls, contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// A browser-automation connector: give the AGENT a real, logged-in browser for one platform whose API can't
// cover "all the actions". The PLATFORM is data in an installed extension's `contributes.capabilities` (its card,
// its login URL, its cheatsheet); this handler is the generic plumbing over it. `apply` renders the platform's
// SKILL.md into .agents/skills/<id> (loaded-skills.ts projects it to every runtime) and its `fragment` is the
// browser feature pack — Chromium + Xvfb as one unit (packs/browser.Dockerfile), nothing when the running base
// image already bakes it (the standard image does; a core image rides it through an owner rebuild).
// The login lands in a Chromium profile under .intentic/local/browser/<id> by either of two hands: the owner's own,
// over the /system/browser-profile WebSocket, or the AGENT's — its @playwright/mcp mounts over the same profile
// while the account is still pending, signs in (or up) using the stored credentials the daemon types for it
// (browser/accounts-tools.ts), and marks the account connected. Either way the owner can reopen that same
// profile by hand on the same route. Distinct from `cli` (env credential + curl) — here the credential is the
// browser session itself, plus the optional stored password the accounts tools type but never reveal.
//
// ONE ENTRY IS ONE ACCOUNT, not one site: several entries may name the same platform (reddit-work and
// reddit-personal), and everything that carries identity — the profile, the login, the passkey — is keyed by the
// entry's ID (session-store.ts), as this handler's skill file and the agent's tool prefix already are. So the
// status below asks whether THIS account signed in, and the removal takes only this account's session with it.

// Is the browser pack actually present — Chromium at playwright's cache path AND Xvfb on PATH? The probe for
// the "rebuild pending" state between "add" and "rebuild" (on a core image the pack rides the overlay). Both
// halves checked because the pack installs them as one unit and a half-present browser is unusable: Chromium
// without Xvfb can only run headless (fingerprinted and blocked), Xvfb without Chromium has nothing to display.
// Exported for the identity handler, whose browser is this same machinery.
export const browserPackInstalled = (): boolean => {
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
    // The account's stored password — what the daemon types into the site on the agent's behalf (the accounts
    // tools) and what the /secrets inventory rotates. Unset for a profile that signed in by hand.
    secret: (config) => ((config as BrowserConfig).password !== undefined ? "password" : undefined),
    // The whole config MINUS the password (masked to hasPassword, the mcp-token precedent): a generic session's
    // page and purpose are exactly what the card's row has to be able to show, its credential is not.
    echo: (config) => {
        const { password, ...rest } = config as BrowserConfig;
        return {
            ...(Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(password !== undefined ? { hasPassword: true } : {}),
        };
    },
    fragment: () => packFragment("browser"),
    /* The connected marker is per ENTRY and always moves; the profile and its passkeys move only for a
     * standalone account, which is the one that OWNS them — an identity-born account renamed out from under its
     * identity must leave the shared browser (and its siblings' logins) exactly where they are. Same division
     * `remove` already draws, for the same reason. */
    rename: {
        carry: async (ctx, from, to, config) => {
            await ((config as BrowserConfig).identity === undefined ? moveSession : moveMarker)(ctx.workspace.root, from, to);
            await removeLoadedSkill(ctx.files, ctx.workspace.root, from);
        },
    },
    apply: async function* (ctx, id, config) {
        const { platform, identity } = config as BrowserConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("browser", platform));
        if (contribution === undefined) {
            throw new Error(`no browser platform "${platform}" — install the extension that declares it`);
        }
        /* WHOSE BROWSER THIS ACCOUNT LIVES IN, resolved at add-time for the same reason the URLs are: a card
         * naming an identity that isn't there would otherwise surface later as browser tools over an empty
         * profile nobody signed in. The identity's email is baked into the skill so the agent knows which
         * address the signup forms get — a fact the platform pack cannot know. */
        const born = identity === undefined ? undefined : await ctx.capabilities.get(identity);
        if (identity !== undefined && born?.kind !== "identity") {
            throw new Error(`no identity "${identity}" — add the identity first, or leave the field empty for a standalone account`);
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
        const note = browserToolsNote(born === undefined ? undefined : { id: born.id, email: (born.config as IdentityConfig).email });
        const skill = await contributedSkill(contribution, id, note, config as Record<string, string>);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${platform}" has no readable skill file — reinstall it`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        yield {
            kind: "log",
            message:
                born === undefined
                    ? `Connected "${id}" on ${site}. Rebuild the sandbox if prompted, then open "Log in" to sign in — or ask the agent to sign in (or sign up) for you. Once connected, the agent acts as you there.`
                    : `Filed "${id}" on ${site} under the identity "${born.id}" — it shares that identity's browser. Ask the agent to sign in (or sign up) through it, or open "Log in" to do it yourself.`,
        };
    },
    // Two distinct pending states. The web UI (Capabilities.vue) routes the rebuild one to the Environment card
    // and the login one to the guided-login window — it distinguishes them by the word "rebuild" in the detail,
    // so keep that word in the rebuild detail (and out of the login detail).
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!browserPackInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, id)) {
            return { state: "pending", detail: "log in to connect your account — or ask the agent to sign in for you" };
        }
        return { state: "active" };
    },
    // A standalone account's removal takes its whole profile with it; an identity-born account's takes only its
    // own marker and skill — the shared browser (and every sibling signed in beside it) belongs to the identity
    // and outlives any one account.
    remove: async (ctx, id, config) => {
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
        if ((config as BrowserConfig).identity === undefined) {
            await clearSession(ctx.workspace.root, id);
        } else {
            await clearMarker(ctx.workspace.root, id);
        }
    },
};
