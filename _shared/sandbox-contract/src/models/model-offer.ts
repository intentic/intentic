import { modelPinKey } from "./model-pins.js";
import type { AgentProvider } from "../schemas/agent.js";
import type { ModelPick } from "../schemas/chat-route.js";

// What the Auto judge is allowed to choose from, and how its reply is read back. Pure: the daemon gathers the facts
// (catalogs, connected accounts, headroom readings) and this turns them into the lines the model sees and the
// validator that reads its answer. Nothing outside the offer can be chosen, so a hallucinated model id is caught here
// rather than at the provider.

export interface OfferedWindow {
    // Narrow token for the pool's length, e.g. "5h", "wk"; absent when nothing names how long the window runs.
    readonly short?: string;
    readonly label?: string;
    // 0-100 REMAINING, the complement of the reading's utilization: the judge is asked about what is left, not spent.
    readonly left: number;
    // Epoch seconds, as every reset instant on this wire.
    readonly resetsAt?: number;
}

export interface OfferedAccount {
    readonly id: string;
    // The owner's own name for it where there is one; the id is what must be replied with either way.
    readonly label?: string;
    // Empty means never measured, which is not the same as measured full and must not read as it.
    readonly windows: readonly OfferedWindow[];
}

export interface OfferedModel {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly label: string;
    // Weakest first, as the catalog row published them; empty means this model takes no effort setting.
    readonly efforts: readonly string[];
    // One short clause about what the model is for, where the catalog carries one.
    readonly note?: string;
}

export interface ModelOffer {
    // Already filtered: a model whose every account is at cap never reaches here.
    readonly models: readonly OfferedModel[];
    // Accounts that can pay, per provider id. A provider with none still offers its models: an unnamed account is a
    // real state (a plain key, an endpoint), and the turn resolves one itself.
    readonly accounts: Readonly<Record<string, readonly OfferedAccount[]>>;
}

// Relative phrasing of a reset, since an absolute instant would need the reader's timezone; deliberately coarse at
// every scale. `reopensAt` is epoch seconds, `now` epoch ms.
export const renewsInWords = (reopensAt: number, now: number): string => {
    const seconds = reopensAt - Math.floor(now / 1000);
    if (seconds <= 60) {
        return `any moment`;
    }
    if (seconds < 60 * 60) {
        return `in about ${Math.round(seconds / 60)} min`;
    }
    if (seconds < 36 * 60 * 60) {
        return `in about ${Math.round(seconds / 3600)}h`;
    }
    return `in about ${Math.round(seconds / 86_400)} days`;
};

const windowWords = (window: OfferedWindow, now: number): string => {
    const name = window.short ?? window.label ?? `allowance`;
    const renews = window.resetsAt === undefined ? `` : ` (renews ${renewsInWords(window.resetsAt, now)})`;
    return `${name}: ${Math.round(window.left)}% left${renews}`;
};

// An account with no reading says so rather than being left off: "not measured" is a fact the judge should weigh,
// and an account silently missing from the list would read as one that cannot pay.
const accountLine = (account: OfferedAccount, now: number): string => {
    const name = account.label === undefined || account.label === account.id ? account.id : `${account.id} (${account.label})`;
    const state = account.windows.length === 0 ? `allowance never measured` : account.windows.map((window) => windowWords(window, now)).join(`, `);
    return `- ${name} — ${state}`;
};

const modelLine = (model: OfferedModel): string => {
    const efforts = model.efforts.length === 0 ? `` : ` Effort: ${model.efforts.join(`, `)}.`;
    const note = model.note === undefined ? `` : ` ${model.note.trim().replace(/\.$/u, ``)}.`;
    return `- ${modelPinKey(model)} — ${model.label}.${note}${efforts}`;
};

// The two blocks the prompt shows: what may be run, and who can pay for it. Providers keep the offer's own order, so a
// reply can be compared against the list a person would read.
export const offerLines = (offer: ModelOffer, now: number): readonly string[] => {
    const providers = [...new Set(offer.models.map((model) => model.provider))];
    return [
        `Models you may choose:`,
        ...offer.models.map(modelLine),
        ``,
        `Accounts that can pay, and how much allowance each has left:`,
        ...providers.flatMap((provider) => {
            const accounts = offer.accounts[provider] ?? [];
            return accounts.length === 0
                ? [`- ${provider}: no named account; this provider resolves its own.`]
                : [`- ${provider}:`, ...accounts.map((account) => `  ${accountLine(account, now)}`)];
        }),
    ];
};

// Wrapper words a model reaches for anyway: a fence, a bullet, quotes, a trailing period.
const FENCE_LINE = /^```/u;
const BULLET_LINE = /^[-*•]\s+/u;
const FIELD = /^([a-z][\w-]*)\s*:\s*(.+)$/iu;

const bare = (value: string): string => value.trim().replace(/^[`'"]+/u, ``).replace(/[.`'"]+$/u, ``).trim();

// The reply's `key: value` lines for the keys asked about, lowercased, bullets and fences stripped. First wins: a model
// that answers twice meant its first answer, and a later line is commentary on it. Keys are passed in rather than
// fixed here, since one reply can carry the answers to several questions (chat-route.ts asks two at once), and an
// empty map is the honest way to tell a keyed reply from a bare one-word one.
export const replyFields = (reply: string, keys: readonly string[]): ReadonlyMap<string, string> => {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const fields = new Map<string, string>();
    for (const line of reply.split(`\n`)) {
        const trimmed = line.trim().replace(BULLET_LINE, ``);
        const found = FENCE_LINE.test(trimmed) ? null : FIELD.exec(trimmed);
        const key = found?.[1]?.toLowerCase();
        if (key !== undefined && wanted.has(key) && found?.[2] !== undefined && !fields.has(key)) {
            fields.set(key, bare(found[2]));
        }
    }
    return fields;
};

export interface ParsedPick {
    readonly pick: ModelPick | undefined;
    // The reply's literal model line, for the sentence explaining why a rung was stepped over.
    readonly token: string;
}

// Reads the keyed reply (`model:` / `effort:` / `account:`) against the offer. The MODEL is the load-bearing choice:
// one that names nothing offered yields no pick, and the caller steps to the next rung rather than running an id no
// provider has. An unrecognised effort or account is dropped instead, keeping the model it came with — those are
// refinements, and the turn's own defaults answer for them correctly.
export const parseModelPick = (reply: string, offer: ModelOffer): ParsedPick => {
    const fields = replyFields(reply, [`model`, `effort`, `account`]);
    const token = fields.get(`model`) ?? ``;
    const chosen = offer.models.find((model) => modelPinKey(model).toLowerCase() === token.toLowerCase());
    if (chosen === undefined) {
        return { pick: undefined, token };
    }
    const effort = fields.get(`effort`);
    const account = fields.get(`account`);
    const named = (offer.accounts[chosen.provider] ?? []).find((entry) => entry.id.toLowerCase() === account?.toLowerCase());
    return {
        pick: {
            provider: chosen.provider,
            model: chosen.model,
            ...(effort !== undefined && chosen.efforts.includes(effort.toLowerCase()) ? { effort: effort.toLowerCase() } : {}),
            ...(named === undefined ? {} : { account: named.id }),
        },
        token,
    };
};
