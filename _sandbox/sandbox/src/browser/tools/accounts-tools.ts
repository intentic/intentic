import { randomInt } from "node:crypto";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import { sdk } from "../../runtimes/claude/claude-sdk.js";
import type { AgentEvent, BrowserConfig, Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { z } from "zod";
import { createRequest, resolveRequest } from "../../agent/tools/agent-requests.js";
import type { OpenAccountInput } from "../../capabilities/open-account.js";
import { browserAccountPage, clearBrowserHelp, raiseBrowserHelp } from "../sessions/browser-sessions.js";
import { type fetchEmailCode, type Mailbox, mailboxOf, siteToken } from "./email-codes.js";
import { hasSession, markConnected, profileOwner } from "../sessions/session-store.js";

// Lets the agent connect, sign in to, sign up for, and open new browser accounts, and call the owner in when a step
// needs a person, instead of every login going through the owner's guided window.
// No credential ever enters the model's context: the daemon types a stored password or generates a new one and stores
// it on the capability; fetch_email_code answers with only the code or link, never the inbox.
// An account is a browser entry or identity (profileOwner resolves either to its live browser); scope is this turn's
// accounts, widened to include one just born from a granted identity.

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// 20 chars, all four classes guaranteed then shuffled; a conservative symbol set most site policies accept.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^*-_+=";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;
const pick = (set: string): string => set[randomInt(set.length)] ?? "";
export const generatePassword = (): string => {
    const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL), ...Array.from({ length: 16 }, () => pick(ALL))];
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
    }
    return chars.join("");
};

// What the daemon needs from the composition, narrowed for tests.
// openAccount/fetchCode are closures, not imports, keeping the seam testable.
export interface AccountsDeps {
    readonly capabilities: {
        readonly get: (id: string) => Promise<Capability | undefined>;
        readonly upsert: (capability: Capability) => Promise<void>;
    };
    readonly root: string;
    // Browser-shaped ids this turn speaks for (accounts and identities); same filter the browser servers got.
    readonly accounts: readonly string[];
    readonly conversationId?: string | undefined;
    // False on an unattended turn: request_help is hidden (would park on nobody there); other tools stay available.
    readonly attended: boolean;
    // Files a new browser account under an identity; the switch gate lives in capabilities/open-account.ts.
    readonly openAccount: (input: OpenAccountInput) => Promise<string>;
    // Newest code or link a site sent to a mailbox (email-codes.ts).
    readonly fetchCode: (mailbox: Mailbox, site: string, now: Date) => ReturnType<typeof fetchEmailCode>;
    // Second gate check though a gated account is usually unmounted: mount filter and grants can change mid-turn.
    readonly release: (account: string, lane: "session" | "otp", detail: string) => Promise<{ readonly ok: true } | { readonly refusal: string }>;
}

// Resolved per call, not cached at server build: a password added mid-turn, or an account opened mid-turn by
// open_account, must be visible to the very next call.
const turnEntry = async (deps: AccountsDeps, id: string): Promise<Capability | undefined> => {
    const capability = await deps.capabilities.get(id);
    if (capability === undefined || (capability.kind !== "browser" && capability.kind !== "identity")) {
        return undefined;
    }
    if (deps.accounts.includes(id)) {
        return capability;
    }
    // Born of a granted identity: in scope with it, since the entry lives in a browser this turn already holds.
    const identity = capability.kind === "browser" ? (capability.config as BrowserConfig).identity : undefined;
    return identity !== undefined && deps.accounts.includes(identity) ? capability : undefined;
};

const NO_ACCOUNT = (id: string): string =>
    `no account "${id}" this turn can act through: the account is a browser entry's (or identity's) capability id; the skill that taught you its tools names it`;

// Site an account is on, as a person would say it: platform alone is just the card name ("website" for the generic
// session), so the host wins when there is one.
export const siteLabel = (config: BrowserConfig): string => {
    const url = config["homeUrl"] ?? config["loginUrl"];
    if (url === undefined || url === "") {
        return config.platform;
    }
    try {
        return new URL(url).host;
    } catch {
        return config.platform;
    }
};

// One account's roster line: what, where, signed-in state, and what it's for and when, to decide whether to reuse it.
export const accountLine = (root: string, capability: Capability): string => {
    const config = capability.config as BrowserConfig;
    const notes = [
        hasSession(root, capability.id) ? "signed in" : "not signed in yet",
        ...(config.purpose === undefined || config.purpose === "" ? [] : [config.purpose]),
        ...(config.openedAt === undefined || config.openedAt === "" ? [] : [`opened ${config.openedAt}`]),
    ];
    return `  ${capability.id} · ${siteLabel(config)} · ${notes.join(" · ")}`;
};

// Identity an entry answers mail through: itself, or the one it was born from; undefined for a standalone account.
const identityBehind = async (deps: AccountsDeps, capability: Capability): Promise<Capability | undefined> => {
    if (capability.kind === "identity") {
        return capability;
    }
    const id = (capability.config as BrowserConfig).identity;
    if (id === undefined) {
        return undefined;
    }
    const identity = await deps.capabilities.get(id);
    return identity?.kind === "identity" ? identity : undefined;
};

// Stored value type_credential types: an identity's username is its email; an identity-born account with none of its
// own falls back to its identity's email.
const credentialValue = async (deps: AccountsDeps, capability: Capability, field: "username" | "password"): Promise<string | undefined> => {
    if (capability.kind === "identity") {
        const config = capability.config as IdentityConfig;
        return field === "username" ? config.email : config.password;
    }
    const config = capability.config as BrowserConfig;
    if (field === "password") {
        return config.password;
    }
    if (config.username !== undefined && config.username !== "") {
        return config.username;
    }
    const identity = await identityBehind(deps, capability);
    return identity === undefined ? undefined : (identity.config as IdentityConfig).email;
};

// Whether the focused element can take typed text, checked first so a mis-click doesn't send a credential into the
// wrong field.
export const focusedEditable = async (page: import("playwright").Page): Promise<boolean> =>
    page
        .evaluate(() => {
            const el = document.activeElement;
            if (el === null) {
                return false;
            }
            const tag = el.tagName.toLowerCase();
            return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
        })
        .catch(() => false);

export type AccountsServerFactory = (push: (event: AgentEvent) => void, signal: AbortSignal) => McpSdkServerConfigWithInstance;

export const accountsServer =
    (deps: AccountsDeps): AccountsServerFactory =>
    (push, signal) =>
        sdk().createSdkMcpServer({
            name: "accounts",
            // Deferred behind tool search (SDK default); account skills tell a turn holding accounts how to load it.
            tools: [
                sdk().tool(
                    "type_credential",
                    "Type an account's STORED username or password into the focused field of its live browser page. You never see the value: click the field with the browser tools first, then call this. An identity's username is its email; an identity-born account with no username of its own types its identity's email. The result confirms the typed username (you may need it, e.g. to find its inbox); a password is never echoed.",
                    {
                        account: z.string().describe("The account (capability id) whose credential to type"),
                        field: z.enum(["username", "password"]).describe("Which stored value to type"),
                    },
                    async ({ account, field }) => {
                        const capability = await turnEntry(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        const value = await credentialValue(deps, capability, field);
                        if (value === undefined || value === "") {
                            return fail(
                                field === "password"
                                    ? `no password is stored for "${account}": ask the owner to add it on the account's card, or raise request_help so they can type it themselves`
                                    : `no username is stored for "${account}", ask the owner, or read it off the site if it is visible`,
                            );
                        }
                        const page = browserAccountPage(profileOwner(capability));
                        if (page === undefined) {
                            return fail(`"${account}" has no live browser page: open the site with its browser tools first`);
                        }
                        if (!(await focusedEditable(page))) {
                            return fail("no text field is focused on the page: browser_click the field first, then call this again");
                        }
                        const released = await deps.release(account, "session", `type the stored ${field} for ${account}`);
                        if ("refusal" in released) {
                            return fail(released.refusal);
                        }
                        // Human-ish keystroke cadence matching this profile's stealth posture; insertText skips key
                        // events forms need.
                        await page.keyboard.type(value, { delay: 30 });
                        return ok(field === "username" ? `typed the stored username: ${value}` : "typed the stored password (not shown)");
                    },
                ),
                sdk().tool(
                    "create_password",
                    "Generate a strong password for a browser account and STORE it on the account's card (its secret). You never see it: fill sign-up forms by focusing the password field and calling type_credential (twice for a confirm field). Refuses to replace an existing stored password unless `replace` is set.",
                    {
                        account: z.string().describe("The browser account (capability id) to store the password on"),
                        replace: z.boolean().optional().describe("Replace an already-stored password (e.g. the site rejected it)"),
                    },
                    async ({ account, replace }) => {
                        const capability = await turnEntry(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        if (capability.kind === "identity") {
                            // Identity's provider login stays the owner's; its password is set on the card, never
                            // minted by a turn.
                            return fail(`"${account}" is an identity: its email password is the owner's to set on the identity's card`);
                        }
                        const config = capability.config as BrowserConfig;
                        if (config.password !== undefined && config.password !== "" && replace !== true) {
                            return fail(
                                `"${account}" already stores a password, type it with type_credential, or pass replace: true if the site refused it`,
                            );
                        }
                        // Minting a password onto a gated account changes the credential, as much the approver's
                        // business as spending.
                        const released = await deps.release(account, "session", `store a new generated password on ${account}`);
                        if ("refusal" in released) {
                            return fail(released.refusal);
                        }
                        await deps.capabilities.upsert({ ...capability, config: { ...config, password: generatePassword() } } as Capability);
                        return ok(
                            `generated and stored a strong password for "${account}": focus the site's password field and call type_credential to enter it`,
                        );
                    },
                ),
                sdk().tool(
                    "mark_connected",
                    "Mark an account as connected, AFTER you verified the sign-in landed (you are on the site signed in as the account, not on a login page). For an identity: after its email provider shows you signed in. This is what flips the capability from pending to active, so future turns get its browser already authenticated.",
                    { account: z.string().describe("The account (capability id) that is now signed in") },
                    async ({ account }) => {
                        const capability = await turnEntry(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        await markConnected(deps.root, account);
                        return ok(`"${account}" is marked connected: its browser opens signed in from now on`);
                    },
                ),
                sdk().tool(
                    "fetch_email_code",
                    "The newest verification code or confirmation link a site emailed to this account's identity, and nothing else; you never see the inbox. Reads the mailbox linked on the identity's card, looks at the last half hour, and answers with the sender, subject, codes and links of the newest mail from the site you are signing into. Open confirmation links in the identity's own browser.",
                    { account: z.string().describe("The account (capability id) whose identity's mailbox to ask") },
                    async ({ account }) => {
                        const capability = await turnEntry(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        const identity = await identityBehind(deps, capability);
                        if (identity === undefined) {
                            return fail(
                                `"${account}" has no identity behind it: there is no linked mailbox to ask. If an email inbox is connected (the IMAP skill), search it yourself`,
                            );
                        }
                        const mailboxId = (identity.config as IdentityConfig).mailbox;
                        const mailbox = mailboxId === undefined || mailboxId === "" ? undefined : mailboxOf(await deps.capabilities.get(mailboxId));
                        if (mailbox === undefined) {
                            return fail(
                                `the identity "${identity.id}" links no readable mailbox: open its webmail in its own browser (the browser tools with account "${identity.id}") and read the one mail there`,
                            );
                        }
                        // Site is wherever the account's browser is stuck now, falling back to the platform slug
                        // pre-navigation.
                        const page = browserAccountPage(profileOwner(capability));
                        const site =
                            page !== undefined
                                ? new URL(page.url()).host
                                : capability.kind === "browser"
                                  ? (capability.config as BrowserConfig).platform
                                  : ((identity.config as IdentityConfig).email.split("@")[1] ?? "");
                        try {
                            const match = await deps.fetchCode(mailbox, site, new Date());
                            if (match === undefined) {
                                return fail(
                                    `no mail from ${siteToken(site)} in the last half hour: wait a moment and try again, or re-request the code on the page`,
                                );
                            }
                            const codes = match.codes.length === 0 ? "" : `\ncodes: ${match.codes.slice(0, 5).join(", ")}`;
                            const links = match.links.length === 0 ? "" : `\nlinks:\n${match.links.slice(0, 3).join("\n")}`;
                            return ok(`newest mail from ${siteToken(site)}: "${match.subject}" (${match.from})${codes}${links}`);
                        } catch (error) {
                            const message = errorMessage(error);
                            return fail(`could not read the mailbox: ${message}, check the mailbox entry on the identity's card`);
                        }
                    },
                ),
                sdk().tool(
                    "open_account",
                    "Open a NEW platform account through an identity: files a browser account under it (they share the identity's browser), so you can then perform the signup there, prefer the site's \"Continue with\" the identity's provider; fall back to email signup with fetch_email_code for the confirmation. Works for ANY site: one the sandbox has a card for gets that site's cheatsheet, anything else rides the generic browser session, pass homeUrl and it files fine. This is the only record that the account exists, so file it as part of signing up, never afterwards from memory. Refused unless the identity's owner turned on \"may open accounts\". Tell the owner what you opened and why.",
                    {
                        account: z.string().describe('An id for the new account (e.g. "reddit-main"), becomes the capability id'),
                        platform: z
                            .string()
                            .describe(
                                'The site, by name (e.g. "reddit", "x", "producthunt"): a known one brings its own cheatsheet, any other rides the generic session',
                            ),
                        identity: z.string().describe("The identity (capability id) to open it through"),
                        purpose: z
                            .string()
                            .min(1)
                            .describe(
                                "One line on what this account is for: what a later session reads to decide whether to reuse it instead of opening another",
                            ),
                        homeUrl: z
                            .string()
                            .optional()
                            .describe(
                                "The page this account lives on once signed in. Required for a site the sandbox has no card for; ignored for one it does",
                            ),
                        loginUrl: z.string().optional().describe("Only when signing in happens somewhere else than the page above"),
                    },
                    async ({ account, platform, identity, purpose, homeUrl, loginUrl }) => {
                        // Identity must be one this turn speaks for, same scope every other tool checks.
                        const holder = await turnEntry(deps, identity);
                        if (holder === undefined || holder.kind !== "identity") {
                            return fail(`no identity "${identity}" this turn can act through: name the identity whose skill you are holding`);
                        }
                        try {
                            const report = await deps.openAccount({ id: account, platform, identity, purpose, homeUrl, loginUrl });
                            return ok(
                                `${report}\nNow perform the sign-up in the identity's browser (the browser tools with account "${identity}"), SSO first; call mark_connected("${account}") once you verifiably are the account.`,
                            );
                        } catch (error) {
                            return fail(errorMessage(error));
                        }
                    },
                ),
                sdk().tool(
                    "roster",
                    "Who this sandbox is online: every identity you can act as, the accounts each already holds (site, what it was opened for, when, and whether it is signed in), and which identities hold nothing yet. Read this BEFORE opening an account anywhere, signing in to one that exists beats minting another, and an identity with no accounts is the one to spend on a site that should not be tied to the others. Derived from the live manifest, so it is never out of date.",
                    {},
                    async () => {
                        // Scoped to this turn's accounts like every tool here: a narrowed persona must not see the
                        // other entries.
                        const entries = (await Promise.all(deps.accounts.map((id) => deps.capabilities.get(id)))).filter(
                            (capability): capability is Capability => capability !== undefined,
                        );
                        const identities = entries.filter((capability) => capability.kind === "identity");
                        const accounts = entries.filter((capability) => capability.kind === "browser");
                        const sections = identities.map((identity) => {
                            const config = identity.config as IdentityConfig;
                            const held = accounts.filter((account) => (account.config as BrowserConfig).identity === identity.id);
                            const head = `${identity.id} · ${config.email} · ${
                                hasSession(deps.root, identity.id) ? "provider signed in" : "provider NOT signed in yet"
                            } · ${config.openAccounts === "on" ? "may open accounts" : "may NOT open accounts"}`;
                            // "no accounts yet" stated outright, not left as an absence.
                            return held.length === 0
                                ? `${head}\n  no accounts yet`
                                : [head, ...held.map((account) => accountLine(deps.root, account))].join("\n");
                        });
                        // Accounts with no identity behind them: the owner's own hand-connected logins, listed
                        // regardless of origin.
                        const standalone = accounts.filter((account) => (account.config as BrowserConfig).identity === undefined);
                        const tail =
                            standalone.length === 0
                                ? []
                                : [["standalone accounts (no identity)", ...standalone.map((account) => accountLine(deps.root, account))].join("\n")];
                        const all = [...sections, ...tail];
                        return ok(all.length === 0 ? "this turn speaks for no identities or accounts" : all.join("\n\n"));
                    },
                ),
                ...(deps.attended
                    ? [
                          sdk().tool(
                              "request_help",
                              "Ask the owner to step into this account's live browser and clear something only a person can (a captcha, a password you don't hold, a phone check). Your browser stays open; the owner sees your message on the Browsers view, takes control, fixes that step, and hands back: this call waits for them and returns how it ended. Say precisely what you need done.",
                              {
                                  account: z.string().describe("The account (capability id) whose page needs the owner"),
                                  message: z.string().min(1).describe("What you need the owner to do, in one or two sentences"),
                              },
                              async ({ account, message }) => {
                                  const capability = await turnEntry(deps, account);
                                  if (capability === undefined) {
                                      return fail(NO_ACCOUNT(account));
                                  }
                                  const { id, wait } = createRequest(
                                      "browser_help",
                                      { kind: "browser_help", requestId: "", helped: false, note: "the turn ended before anyone could help" },
                                      deps.conversationId,
                                  );
                                  const session = raiseBrowserHelp(profileOwner(capability), { requestId: id, message, requestedAt: Date.now() });
                                  if (session === undefined) {
                                      // Settles the just-parked waiter so nothing holds its id, before reporting why.
                                      resolveRequest({ kind: "browser_help", requestId: id, helped: false });
                                      return fail(`"${account}" has no live browser to take control of: open the page you are stuck on first`);
                                  }
                                  push({ kind: "browser_help", requestId: id, session, account, message });
                                  const { reply, resolved } = await wait(signal);
                                  clearBrowserHelp(id);
                                  push(resolved);
                                  const note = reply.note === undefined || reply.note === "" ? "" : ` They say: ${reply.note}`;
                                  return ok(
                                      reply.helped
                                          ? `The owner stepped in and is done: re-check the page state before continuing.${note}`
                                          : `The owner could not help right now, note where you are stuck and continue with what you can.${note}`,
                                  );
                              },
                          ),
                      ]
                    : []),
            ],
        });
