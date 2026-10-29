import type { ShareableAccount } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { LoginStart, Model, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { ProviderRefusals, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { homeRecording, seatsOff } from "../../mode";
import { STARTED_AT } from "../board/roster";
import { SEAT_OFF } from "./seatOff";

// The connected accounts and model catalogs the Agent tab reads: two Claude subscriptions, the translator's rows in
// every state it can show, and one catalog per provider the picker lists.

// Every Claude account turned off by its organization under `?seats=off` (mode.ts seatsOff), and when it was done.
const seatOff = (account: OauthAccount): OauthAccount => (seatsOff ? { ...account, seatRefusal: SEAT_OFF } : account);
const SEAT_OFF_AGO_MS = 52 * 60_000;

// Built on first read rather than at load: they read the roster's clock, and the roster's own imports reach this module
// (through platform.ts's catalogs) before that clock is set.
export const demoClaudeAccount = (): OauthAccount => seatOff({
    id: `acc_claude_demo`,
    label: `Claude Max`,
    email: `ada@acme.dev`,
    organization: `Acme`,
    connectedAt: STARTED_AT - 30 * 24 * 3_600_000,
    // A plan's pools as the tree the Usage tab and chat rail draw: the session and the Opus slice inside the week.
    usage: {
        measuredAt: STARTED_AT - 4 * 60_000,
        windows: [
            { kind: `seven_day`, utilization: 29, resetsAt: Math.round(STARTED_AT / 1000) + 3 * 24 * 3600, gates: `all` },
            { kind: `five_hour`, utilization: 50, resetsAt: Math.round(STARTED_AT / 1000) + 2 * 3600, gates: `all` },
            { kind: `seven_day_opus`, utilization: 64, resetsAt: Math.round(STARTED_AT / 1000) + 3 * 24 * 3600, gates: { models: [`Opus`] } },
        ],
    },
});

export const demoClaudeAccountSecond = (): OauthAccount => seatOff({
    id: `acc_claude_demo_2`,
    label: `Claude Pro`,
    email: `work@acme.dev`,
    organization: `Acme`,
    connectedAt: STARTED_AT - 12 * 24 * 3_600_000,
    // A spent week with a fresh session inside it: the session's room is drawn, faded, as waiting on the week.
    usage: {
        measuredAt: STARTED_AT - 4 * 60_000,
        windows: [
            { kind: `seven_day`, utilization: 100, resetsAt: Math.round(STARTED_AT / 1000) + 26 * 3600, gates: `all` },
            { kind: `five_hour`, utilization: 8, resetsAt: Math.round(STARTED_AT / 1000) + 4 * 3600, gates: `all` },
        ],
    },
});

export const demoTranslatorAccounts = (): TranslatorAccounts => ({
    codex: [{
        name: `chatgpt-ada`,
        label: `ada@acme.dev`,
        usage: homeRecording ? {
            measuredAt: STARTED_AT - 4 * 60_000,
            windows: [
                { kind: `seven_day`, utilization: 18, resetsAt: Math.round(STARTED_AT / 1000) + 4 * 24 * 3600, gates: `all` },
                { kind: `five_hour`, utilization: 24, resetsAt: Math.round(STARTED_AT / 1000) + 3 * 3600, gates: `all` },
            ],
        } : undefined,
    }],
    grok: [],
    kimi: [],
    // One of every state a Google row can be in, so the Agent tab shows what each says: serving, waiting on its owner
    // to verify it, its allowance spent, and benched by the proxy until an instant.
    gemini: homeRecording ? [] : [
        {
            name: `antigravity-ada.json`,
            label: `ada@acme.dev`,
            usage: {
                measuredAt: STARTED_AT - 6 * 60_000,
                windows: [
                    { kind: `seven_day`, utilization: 29, resetsAt: Math.round(STARTED_AT / 1000) + 3 * 24 * 3600, gates: `all` },
                    { kind: `five_hour`, utilization: 36, resetsAt: Math.round(STARTED_AT / 1000) + 2 * 3600, gates: `all` },
                ],
            },
        },
        {
            name: `antigravity-lin.json`,
            label: `lin@acme.dev`,
            cooling: { reason: `Verify your account to continue.`, verify: `https://accounts.google.com/signin/continue` },
        },
        {
            name: `antigravity-grace.json`,
            label: `grace@acme.dev`,
        },
        {
            name: `antigravity-alan.json`,
            label: `alan@acme.dev`,
            cooling: { until: Math.round(STARTED_AT / 1000) + 40 * 60, reason: `Resource has been exhausted.` },
        },
    ],
});

const CLAUDE_MODELS: Model[] = [
    { id: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `max`], badges: [`reasoning`] },
    { id: `claude-sonnet-5`, label: `Claude Sonnet 5`, efforts: [`low`, `medium`, `high`] },
    { id: `claude-haiku-4-5-20251001`, label: `Claude Haiku 4.5`, badges: [`fast`] },
];

// GPT-5.2 is the one model refused on every credential for a while (demoRefusals below), so the picker shows it waiting.
const CODEX_MODELS: Model[] = [
    { id: `gpt-5.2-codex`, label: `GPT-5.2 Codex`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gpt-5.2`, label: `GPT-5.2`, efforts: [`low`, `medium`, `high`] },
];

// Google's routed lane serves other makers' models, so its catalog is mixed rather than Gemini-only.
const GEMINI_MODELS: Model[] = [
    { id: `claude-opus-4-6`, label: `Claude Opus 4.6 (Thinking)`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gemini-3-1-pro`, label: `Gemini 3.1 Pro`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gemini-3-5-flash`, label: `Gemini 3.5 Flash`, efforts: [`low`, `medium`, `high`], badges: [`fast`] },
    { id: `gpt-oss-120b`, label: `GPT-OSS 120B`, efforts: [`low`, `medium`, `high`] },
];

// Claude and Codex are connected; Google is listed while still locked, which is what a new user meets first
// and the only state where the picker's whole locked band is on screen.
export const DEMO_CATALOGS: Readonly<Record<string, { models: Model[]; default: string }>> = {
    claude: { models: CLAUDE_MODELS, default: `claude-sonnet-5` },
    codex: { models: CODEX_MODELS, default: `gpt-5.2-codex` },
    gemini: { models: GEMINI_MODELS, default: `gemini-3-1-pro` },
};

// What the providers have refused, as the daemon's ledger holds it (agent.refusals): the verdict on every account and
// model is the editor's to judge from these beside each account's usage. A spent week on one Google account, and one
// Codex model refused on every credential until a little after load.
export const demoRefusals = (): ProviderRefusals => ({
    refusals: homeRecording ? {} : {
        gemini: [
            {
                at: STARTED_AT - 20 * 60_000,
                kind: `limit`,
                message: `Resource has been exhausted (e.g. check quota).`,
                account: `antigravity-grace.json`,
                resetsAt: Math.round(STARTED_AT / 1000) + 3 * 24 * 3600,
            },
        ],
        // The organization's refusal on file under `?seats=off`, which dates the account rows' "Off" line.
        claude: seatsOff
            ? [`acc_claude_demo`, `acc_claude_demo_2`].map((account) => ({ at: STARTED_AT - SEAT_OFF_AGO_MS, kind: `entitlement` as const, message: SEAT_OFF, account }))
            : [],
        codex: [
            {
                at: Date.now() - 5 * 60_000,
                kind: `limit`,
                message: `You've hit your usage limit for this model.`,
                model: `gpt-5.2`,
                resetsAt: Math.floor(Date.now() / 1000) + 45 * 60,
            },
        ],
    },
});

// A provider-account sign-in, started: the shape each provider would really take, so the connect panel can be seen in each.
// Devin's is a redirect two of the owner's machines watch, Claude's a paste-back, every other one a device code. None lands.
export const demoSignInStart = (provider: string, variant: string | undefined, state: string): LoginStart => ({
    url: `https://example.com/demo-sign-in?provider=${provider}`,
    code: provider === `devin` || provider === `claude` ? `` : `DEMO-4821`,
    state: provider === `devin` ? state : ``,
    flow: provider === `devin` ? `redirect` : provider === `claude` ? `paste` : `device`,
    variant: variant ?? ``,
    handshake: `demo-handshake-${provider}`,
    expiresAt: Date.now() + 15 * 60 * 1000,
    catchers:
        provider === `devin`
            ? [
                  { kind: `device`, label: `omen` },
                  { kind: `device`, label: `rog` },
              ]
            : [],
});

// WHAT ANOTHER OF THE OWNER'S SANDBOXES HOLDS: Ada's laptop (world/sandboxRegistry.ts LENDING_SANDBOX), so Sandbox ▸
// Models' "From your other sandboxes" has accounts to bring in, one of each way: a Claude sign-in it lends turn by turn,
// two keys it copies, and two it cannot share, each saying why.

/** One account the lending sandbox holds: how its Models page lists it, and the row a copy or a loan files here. */
export interface LentFixture {
    readonly shareable: ShareableAccount;
    readonly row: OauthAccount;
}

export const lendingAccounts = (): readonly LentFixture[] => {
    const connectedAt = STARTED_AT - 9 * 24 * 3_600_000;
    const usage: OauthAccount[`usage`] = {
        measuredAt: STARTED_AT - 3 * 60_000,
        windows: [
            { kind: `seven_day`, utilization: 41, resetsAt: Math.round(STARTED_AT / 1000) + 2 * 24 * 3600, gates: `all` },
            { kind: `five_hour`, utilization: 12, resetsAt: Math.round(STARTED_AT / 1000) + 3 * 3600, gates: `all` },
        ],
    };
    const row = (id: string, label: string, email: string): OauthAccount => ({ id, label, email, connectedAt });
    return [
        {
            shareable: { provider: `claude`, account: `acc_laptop_max`, label: `Claude Max`, email: `ada@lovelace.dev`, mode: `lend` },
            row: { ...row(`acc_laptop_max`, `Claude Max`, `ada@lovelace.dev`), organization: `Lovelace`, usage },
        },
        {
            shareable: { provider: `cursor`, account: `cur_laptop`, label: `Cursor Pro`, email: `ada@lovelace.dev`, mode: `copy` },
            row: row(`cur_laptop`, `Cursor Pro`, `ada@lovelace.dev`),
        },
        {
            shareable: { provider: `zai`, account: `zai_laptop`, label: `GLM Coding Plan`, email: `ada@lovelace.dev`, mode: `copy` },
            row: row(`zai_laptop`, `GLM Coding Plan`, `ada@lovelace.dev`),
        },
        {
            shareable: {
                provider: `claude`,
                account: `acc_laptop_team`,
                label: `Claude Team`,
                email: `ada@acme.dev`,
                mode: `no`,
                reason: `It needs signing in again here first.`,
            },
            row: { ...row(`acc_laptop_team`, `Claude Team`, `ada@acme.dev`), needsReauth: true },
        },
        {
            shareable: {
                provider: `codex`,
                label: `ChatGPT`,
                email: `ada@lovelace.dev`,
                mode: `no`,
                reason: `Subscriptions the translator holds can't be lent between sandboxes yet: sign in on this sandbox too.`,
            },
            row: row(`codex`, `ChatGPT`, `ada@lovelace.dev`),
        },
    ];
};
