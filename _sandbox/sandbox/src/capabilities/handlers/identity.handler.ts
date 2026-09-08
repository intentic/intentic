import type { IdentityConfig } from "@intentic/sandbox-contract";
import { clearSession, hasSession, moveSession } from "../../browser/sessions/session-store.js";
import { packFragment } from "../../environment/packs.js";
import { loadedSkillFile } from "../../settings/loaded-skills.js";
import { accountSkillNames, convergeAccountSkills } from "../account-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { browserPackInstalled } from "./browser.handler.js";

// One email identity the sandbox acts as online, the browser its accounts are born into (browser handler's sibling). A
// core card, not a contribution: an identity has no site, so the skill renders from core. The connected marker means
// signed into its own provider by the owner, since Google blocks automated sign-in.

// Guided-login start pages; an unknown domain falls back to itself, and `loginUrl` overrides the guess.
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
    // Stored email password, typed in by the daemon for the agent; unset when the owner signs in by hand.
    secret: (config) => ((config as IdentityConfig).password !== undefined ? "password" : undefined),
    echo: (config) => {
        const { password, ...rest } = config as IdentityConfig;
        return {
            ...(Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(password !== undefined ? { hasPassword: true } : {}),
        };
    },
    // Same pack, probe and rebuild story as the browser handler's.
    fragment: () => packFragment("browser"),
    // The profile moves rather than being re-made: an identity's whole point is the sign-in every account beside it
    // shares. Accounts naming this identity are repointed by the route, not here.
    rename: {
        carry: async (ctx, from, to) => {
            await moveSession(ctx.workspace.root, from, to);
        },
    },
    async *apply(ctx, id, config) {
        const { email, mailbox } = config as IdentityConfig;
        if (!email.includes("@")) {
            throw new Error(`"${email}" is not an email address: the identity IS an address, so this field is the card`);
        }
        // Checked here, on the form, so a dangling mailbox reference fails now, not later as a shrugging tool.
        if (mailbox !== undefined && mailbox !== "" && (await ctx.capabilities.get(mailbox)) === undefined) {
            throw new Error(`no capability "${mailbox}" to read mail from: connect the mailbox (IMAP) first, or leave the field empty`);
        }
        // Route upserts after apply; the entry rides in as the delta, not a read-back.
        await convergeAccountSkills(ctx, { upsert: { id, kind: "identity", config: config as IdentityConfig } });
        yield {
            kind: "log",
            message: `Identity "${id}" (${email}) is set up. Rebuild the sandbox if prompted, then open "Log in" and sign into the email provider yourself, that one login stays human. Accounts the agent opens through it will share this browser.`,
        };
    },
    status: async (ctx, id) => {
        if (!accountSkillNames(await ctx.files.read(loadedSkillFile(ctx.workspace.root, "identities")), id)) {
            return { state: "inactive" };
        }
        if (!browserPackInstalled()) {
            return { state: "pending", detail: "rebuild the sandbox to finish browser setup (Environment card)" };
        }
        if (!hasSession(ctx.workspace.root, id)) {
            return { state: "pending", detail: "log in to the email provider yourself, this one sign-in stays human" };
        }
        return { state: "active" };
    },
    // Refuses while accounts still name this identity: their sessions live in its profile, so removing it would sign
    // them all out as a side effect. The message names them since the fix is per-account.
    remove: async (ctx, id) => {
        const born = (await ctx.capabilities.list()).filter(
            (capability) => capability.kind === "browser" && (capability.config.identity ?? "") === id,
        );
        if (born.length > 0) {
            throw new Error(
                `"${id}" still has accounts living in its browser: ${born.map((capability) => capability.id).join(", ")}, remove them first`,
            );
        }
        // Route deletes the entry after this hook; told here to omit it up front.
        await convergeAccountSkills(ctx, { omit: id });
        await clearSession(ctx.workspace.root, id);
    },
};
