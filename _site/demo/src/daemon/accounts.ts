import type { Model, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { ProviderRefusals, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { STARTED_AT } from "./roster";

// The connected accounts and model catalogs the Agent tab reads: two Claude subscriptions, the translator's rows in
// every state it can show, and one catalog per provider the picker lists.

export const DEMO_CLAUDE_ACCOUNT: OauthAccount = {
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
};

export const DEMO_CLAUDE_ACCOUNT_SECOND: OauthAccount = {
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
};

export const DEMO_TRANSLATOR_ACCOUNTS: TranslatorAccounts = {
    codex: [{ name: `chatgpt-ada`, label: `ada@acme.dev` }],
    grok: [],
    kimi: [],
    // One of every state a Google row can be in, so the Agent tab shows what each says: serving, waiting on its owner
    // to verify it, its allowance spent, and benched by the proxy until an instant.
    gemini: [
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
};

// The refusals on file, which the editor judges every row by (serviceStates) beside its usage: grace's allowance spent
// until the week turns, and one model cooling, every credential the translator holds refused for it until then.
// Relative to load, since an absolute instant in a fixture is a state that reads as expired the next time anyone opens it.
export const demoRefusals = (): ProviderRefusals => ({
    refusals: {
        gemini: [
            {
                at: STARTED_AT - 20 * 60_000,
                kind: `limit`,
                message: `You have exhausted your capacity on this model. Your quota will reset after 72h0m0s.`,
                account: `antigravity-grace.json`,
                resetsAt: Math.round(STARTED_AT / 1000) + 3 * 24 * 3600,
            },
        ],
        codex: [
            {
                at: Date.now() - 5 * 60_000,
                kind: `limit`,
                message: `You've hit your usage limit for GPT-5.2. Try again in 45 minutes.`,
                model: `gpt-5.2`,
                resetsAt: Math.floor(Date.now() / 1000) + 45 * 60,
            },
        ],
    },
});

const CLAUDE_MODELS: Model[] = [
    { id: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `max`], badges: [`reasoning`] },
    { id: `claude-sonnet-5`, label: `Claude Sonnet 5`, efforts: [`low`, `medium`, `high`] },
    { id: `claude-haiku-4-5-20251001`, label: `Claude Haiku 4.5`, badges: [`fast`] },
];

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
