import type { IdentityConfig } from "@intentic/sandbox-contract";
import { identitySkill } from "../../browser/browser-skill.js";
import { clearSession, hasSession, moveSession } from "../../browser/session-store.js";
import { packFragment } from "../../environment/packs.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { browserPackInstalled } from "./browser.js";

/* ONE EMAIL IDENTITY THE SANDBOX ACTS AS ONLINE — the container browser accounts are born from (see
 * IdentityConfigSchema for the model). This handler is deliberately the browser handler's sibling: the payload
 * is the same machinery (one persisted Chromium profile, the browser feature pack, a skill file), because an
 * identity IS a browser — the one its accounts share. What differs is what the profile means: not "signed into
 * one site" but "signed into its own email provider, with room for the accounts that will live beside it".
 *
 * A CORE CARD, NOT A CONTRIBUTION. Platform cards are extension data because sites vary; an identity has no
 * site — it has an email address, and everything a card would pin (where the sign-in starts) is derivable from
 * it or answered on the form. So there is no contribution lookup here, and the skill is rendered from core
 * (identitySkill) rather than a pack's SKILL.md.
 *
 * The connected marker means "the identity's browser is signed into its provider" — the one login that stays
 * the OWNER's own hands (automated Google sign-ins are what Google blocks), done in the guided window. Its
 * accounts mark themselves connected one by one, exactly like standalone accounts do. */

// Where the guided login starts for this identity — the provider's own sign-in. Known mail hosts get their real
// login pages; anything else falls back to the address's own domain, which for hosted mail commonly serves (or
// redirects to) the provider's webmail — and `loginUrl` on the card overrides the guess entirely.
const PROVIDER_LOGINS: Record<string, string> = {
    "gmail.com": "https://accounts.google.com/",
    "googlemail.com": "https://accounts.google.com/",
    "outlook.com": "https://login.live.com/",
    "hotmail.com": "https://login.live.com/",
    "live.com": "https://login.live.com/",
    "yahoo.com": "https://login.yahoo.com/",
    "proton.me": "https://account.proton.me/login",
    "protonmail.com": "https://account.proton.me/login",
    "icloud.com": "https://www.icloud.com/",
};

export const identityLoginUrl = (config: IdentityConfig): string => {
    if (config.loginUrl !== undefined && config.loginUrl !== "") {
        return config.loginUrl;
    }
    const domain = config.email.includes("@") ? config.email.slice(config.email.indexOf("@") + 1).toLowerCase() : "";
    return PROVIDER_LOGINS[domain] ?? `https://${domain === "" ? "accounts.google.com" : domain}/`;
};

export const identityHandler: CapabilityHandler = {
    // The identity's stored email password — typed into the provider by the daemon on the agent's behalf (the
    // accounts tools), never revealed. Unset for the common case: the owner signs the provider in by hand.
    secret: (config) => ((config as IdentityConfig).password !== undefined ? "password" : undefined),
    echo: (config) => {
        const { password, ...rest } = config as IdentityConfig;
        return {
            ...(Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(password !== undefined ? { hasPassword: true } : {}),
        };
    },
    // The identity's browser is the browser pack — same probe, same fragment, same rebuild story.
    fragment: () => packFragment("browser"),
    /* An identity's browser is the whole point of it: the Google sign-in that makes "Continue with Google" a
     * click, and every account living beside it. So the profile MOVES rather than being re-made — the re-apply
     * that follows only rewrites the skill, which is derived from the new name. The accounts that name this
     * identity are repointed by the route, which is where cross-connection references belong. */
    rename: {
        carry: async (ctx, from, to) => {
            await moveSession(ctx.workspace.root, from, to);
            await removeLoadedSkill(ctx.workspace.root, from);
        },
    },
    apply: async function* (ctx, id, config) {
        const { email, mailbox, openAccounts } = config as IdentityConfig;
        if (!email.includes("@")) {
            throw new Error(`"${email}" is not an email address — the identity IS an address, so this field is the card`);
        }
        // A linked mailbox must be a real connected entry, checked here where the reader is still on the form —
        // a dangling reference would otherwise surface turns later as a code tool that shrugs.
        if (mailbox !== undefined && mailbox !== "" && (await ctx.capabilities.get(mailbox)) === undefined) {
            throw new Error(`no capability "${mailbox}" to read mail from — connect the mailbox (IMAP) first, or leave the field empty`);
        }
        await writeLoadedSkill(ctx.workspace.root, id, identitySkill(id, email, openAccounts === "on"));
        yield {
            kind: "log",
            message: `Identity "${id}" (${email}) is set up. Rebuild the sandbox if prompted, then open "Log in" and sign into the email provider yourself — that one login stays human. Accounts the agent opens through it will share this browser.`,
        };
    },
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!browserPackInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, id)) {
            return { state: "pending", detail: "log in to the email provider yourself — this one sign-in stays human" };
        }
        return { state: "active" };
    },
    /* Removal REFUSES while accounts still name this identity: their sessions live in its profile, so tearing
     * it down would sign every one of them out as a side effect of removing something else. The message names
     * the accounts because the fix is per-account and the reader is about to go do it. */
    remove: async (ctx, id) => {
        const born = (await ctx.capabilities.list()).filter(
            (capability) => capability.kind === "browser" && (capability.config.identity ?? "") === id,
        );
        if (born.length > 0) {
            throw new Error(`"${id}" still has accounts living in its browser: ${born.map((capability) => capability.id).join(", ")} — remove them first`);
        }
        await removeLoadedSkill(ctx.workspace.root, id);
        await clearSession(ctx.workspace.root, id);
    },
};
