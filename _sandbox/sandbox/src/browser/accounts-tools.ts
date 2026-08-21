import { randomInt } from "node:crypto";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, BrowserConfig, Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { z } from "zod";
import { createRequest, resolveRequest } from "../agent/agent-requests.js";
import type { OpenAccountInput } from "../capabilities/open-account.js";
import { browserAccountPage, clearBrowserHelp, raiseBrowserHelp } from "./browser-sessions.js";
import { fetchEmailCode, type Mailbox, mailboxOf, siteToken } from "./email-codes.js";
import { hasSession, markConnected, profileOwner } from "./session-store.js";

/* THE ACCOUNTS TOOLS: what lets the agent CONNECT a browser account itself, sign in, sign up, open a NEW
 * account through an identity, and call for the owner when a step needs a person, instead of every login being
 * the owner's own hands in the guided window.
 *
 * The design rule throughout is the manifest's TOTP rule, applied to passwords: a stored credential must never
 * enter the model's context. So there is no "read the password" tool. The daemon TYPES it, into the focused
 * field of the account's live page, over the same CDP attach the /browsers view watches through, and when the
 * agent signs UP, the daemon GENERATES the password and stores it on the capability, so even a credential the
 * agent caused to exist is one it never saw. The mailbox gets the same treatment: `fetch_email_code` answers
 * with the one code or link a site just sent, never with an inbox. What the model handles is the narrow answer.
 *
 * AN `account` IS A BROWSER ENTRY OR AN IDENTITY, one address space, because the identity is account-shaped
 * everywhere it matters here: it has a stored credential to type (its email, its provider password), a live
 * browser to be helped in, and a connected marker of its own. Every tool resolves the entry's PROFILE OWNER
 * (session-store.ts) to find the live page, which is how three accounts born of one identity share one browser
 * without any tool having to know.
 *
 * Scoped to the accounts THIS TURN may act through (the identity filter turn-plan already applies to the
 * browser servers), with one deliberate widening: an account BORN of a granted identity is in scope with it,
 * including one this very turn just opened, which the grant list captured at turn start cannot have named. */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/* A generated password: 20 characters, all four classes guaranteed. Sites disagree about which symbols they
 * accept, so the symbol set is the conservative handful that virtually every policy allows. Shuffled so the
 * guaranteed classes don't sit at predictable positions. crypto.randomInt throughout, this is a credential. */
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

// What the daemon needs from the composition, narrowed so tests can hand in fakes. `openAccount` and
// `fetchCode` are closures rather than imports for the same reason `capabilities` is a two-method slice: the
// real ones reach Services and the network, and the seam is what keeps these tools testable.
export interface AccountsDeps {
    readonly capabilities: {
        readonly get: (id: string) => Promise<Capability | undefined>;
        readonly upsert: (capability: Capability) => Promise<void>;
    };
    readonly root: string;
    // The browser-shaped capability ids this turn's persona speaks for, accounts and identities alike, the
    // same filter the browser servers got.
    readonly accounts: readonly string[];
    readonly conversationId?: string | undefined;
    // An unattended turn gets no request_help: it would park on a person who is not there. The other tools
    // stay, an automation may finish an email-code login with nobody watching.
    readonly attended: boolean;
    // File a new browser account under an identity (capabilities/open-account.ts, the switch gate lives there).
    readonly openAccount: (input: OpenAccountInput) => Promise<string>;
    // Read the newest code/link a site sent to a mailbox (email-codes.ts).
    readonly fetchCode: (mailbox: Mailbox, site: string, now: Date) => ReturnType<typeof fetchEmailCode>;
}

/* Resolved per call rather than captured at server build: the owner can add a password mid-turn (the agent
 * asked for it in chat, the owner put it on the card) and the very next type_credential should see it, and an
 * account opened mid-turn by open_account must be addressable by the calls right after it. */
const turnEntry = async (deps: AccountsDeps, id: string): Promise<Capability | undefined> => {
    const capability = await deps.capabilities.get(id);
    if (capability === undefined || (capability.kind !== "browser" && capability.kind !== "identity")) {
        return undefined;
    }
    if (deps.accounts.includes(id)) {
        return capability;
    }
    // Born of a granted identity ⇒ in scope with it: the entry lives in a browser this turn already holds.
    const identity = capability.kind === "browser" ? (capability.config as BrowserConfig).identity : undefined;
    return identity !== undefined && deps.accounts.includes(identity) ? capability : undefined;
};

const NO_ACCOUNT = (id: string): string =>
    `no account "${id}" this turn can act through: the account is a browser entry's (or identity's) capability id; the skill that taught you its tools names it`;

/* THE SITE AN ACCOUNT IS ON, as a person would say it. The `platform` slug is the card, and for an account that
 * rides the GENERIC session the card is "website", true and useless. The address it opens at is the fact worth
 * printing, so the host wins whenever there is one. */
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

// One account's line in the roster: what it is, where, whether it is signed in, and the two facts that answer
// "should I reuse this one", what it was opened for and when.
export const accountLine = (root: string, capability: Capability): string => {
    const config = capability.config as BrowserConfig;
    const notes = [
        hasSession(root, capability.id) ? "signed in" : "not signed in yet",
        ...(config.purpose === undefined || config.purpose === "" ? [] : [config.purpose]),
        ...(config.openedAt === undefined || config.openedAt === "" ? [] : [`opened ${config.openedAt}`]),
    ];
    return `  ${capability.id} · ${siteLabel(config)} · ${notes.join(" · ")}`;
};

// The identity an entry answers mail through: itself, or the one it was born from. Undefined for a standalone
// account, which is the "no identity" arm of fetch_email_code's error.
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

// The stored value type_credential types. An identity's username IS its email; an identity-born account with
// no username of its own falls back to its identity's email, the address its signup forms were fed.
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

// The focused element, if it can take typed text. Checked before typing a credential so a mis-click sends the
// password into an error message here rather than into a search box on the wrong part of the page.
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
        createSdkMcpServer({
            name: "accounts",
            alwaysLoad: true,
            tools: [
                tool(
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
                        // A human-ish keystroke cadence, matching the stealth posture of everything else on
                        // this profile; insertText would skip the key events some login forms listen for.
                        await page.keyboard.type(value, { delay: 30 });
                        return ok(field === "username" ? `typed the stored username: ${value}` : "typed the stored password (not shown)");
                    },
                ),
                tool(
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
                            // The identity's provider login is the one this product keeps in the owner's hands,
                            // so its password is theirs to set on the card, never minted by a turn.
                            return fail(`"${account}" is an identity: its email password is the owner's to set on the identity's card`);
                        }
                        const config = capability.config as BrowserConfig;
                        if (config.password !== undefined && config.password !== "" && replace !== true) {
                            return fail(
                                `"${account}" already stores a password, type it with type_credential, or pass replace: true if the site refused it`,
                            );
                        }
                        await deps.capabilities.upsert({ ...capability, config: { ...config, password: generatePassword() } } as Capability);
                        return ok(
                            `generated and stored a strong password for "${account}": focus the site's password field and call type_credential to enter it`,
                        );
                    },
                ),
                tool(
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
                tool(
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
                        // The site is wherever this account's browser is stuck right now, the page asking for
                        // the code, falling back to the platform slug for a call made before any navigation.
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
                            const message = error instanceof Error ? error.message : String(error);
                            return fail(`could not read the mailbox: ${message}, check the mailbox entry on the identity's card`);
                        }
                    },
                ),
                tool(
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
                        // The identity must be one this turn speaks for, the same scope every other tool checks.
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
                            return fail(error instanceof Error ? error.message : String(error));
                        }
                    },
                ),
                tool(
                    "roster",
                    "Who this sandbox is online: every identity you can act as, the accounts each already holds (site, what it was opened for, when, and whether it is signed in), and which identities hold nothing yet. Read this BEFORE opening an account anywhere, signing in to one that exists beats minting another, and an identity with no accounts is the one to spend on a site that should not be tied to the others. Derived from the live manifest, so it is never out of date.",
                    {},
                    async () => {
                        /* Scoped to the accounts this turn speaks for, exactly like every other tool here, a
                         * persona that narrows a turn to two identities must not have the roster hand back the
                         * other fourteen, which is the whole point of narrowing it. */
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
                            // "no accounts yet" said outright rather than left as an absence: a clean identity is
                            // the answer to a question this tool gets asked, not a gap in the list.
                            return held.length === 0
                                ? `${head}\n  no accounts yet`
                                : [head, ...held.map((account) => accountLine(deps.root, account))].join("\n");
                        });
                        // Accounts with no identity behind them, the owner's own hand-connected logins. Listed
                        // because "do we already have an account here" does not care how it came to exist.
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
                          tool(
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
                                      // Settle the just-parked waiter so nothing holds its id, then say why.
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
