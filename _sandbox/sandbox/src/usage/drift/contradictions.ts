import { readingHeadroom } from "@intentic/sandbox-contract/models/plan-pools";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import type { HeadroomService, RefreshScope } from "../headroom.js";

// A turn answered on a model is the provider's own word that the model had room when the request went out. A reading
// taken before then that says every pool the model spends was empty is wrong, whatever made it so: an answer that changed
// shape, a parser that misread it, a pool that moved. Such a reading is marked (AccountUsage.contradicted), which holds
// its full pools at the line rather than spent, said, and re-read. Nothing else ever checks a reading against what the
// provider actually serves, and a wrong one otherwise stands until it happens to be re-read right.

// How often one provider's one model is said while its readings keep being contradicted: each answered turn is one.
const SAY_EVERY_MS = 60 * 60_000;
const saidAt = new Map<string, number>();

// The pools a provider published. A refusal this sandbox recorded itself (`observed:`, observed-limits.ts) is settled by
// the same answer on its own path, and is no reading to be wrong.
const published = (usage: AccountUsage): AccountUsage => ({ ...usage, windows: usage.windows.filter((window) => !window.kind.startsWith("observed:")) });

// The readings the answer speaks for: the account it named, under either key the store files it by, or, for a routed turn
// that names none, every reading of the provider.
export const readingKeys = (stored: Readonly<Record<string, AccountUsage>>, provider: string, account: string | undefined): string[] =>
    account === undefined ? Object.keys(stored).filter((key) => key.startsWith(`${provider}:`)) : [account, `${provider}:${account}`].filter((key) => key in stored);

interface AnsweredDeps {
    readonly headroom: Pick<HeadroomService, "read" | "contradict" | "refresh">;
    readonly logger: Logger;
}

// Never rejects: it runs beside the answered turn, which nothing here may fail.
export const checkAnswered = async (deps: AnsweredDeps, provider: AgentProvider, account: string | undefined, model: string, askedAt: number): Promise<void> => {
    try {
        await contradictReadings(deps, provider, account, model, askedAt);
    } catch (error) {
        deps.logger.warn({ err: error, provider, model }, "headroom: the answered-turn check of the plan-limit readings failed");
    }
};

const contradictReadings = async (deps: AnsweredDeps, provider: AgentProvider, account: string | undefined, model: string, askedAt: number): Promise<void> => {
    const stored = await deps.headroom.read();
    const keys = readingKeys(stored, provider, account);
    const wrong = keys.filter((key) => {
        const usage = stored[key];
        return usage !== undefined && usage.measuredAt < askedAt && readingHeadroom(published(usage), { id: model }).kind === "spent";
    });
    // A routed turn names no account, so the answer proves only that one of them had room: wrong once all of them say none.
    if (wrong.length === 0 || (account === undefined && wrong.length < keys.length)) {
        return;
    }
    const at = Date.now();
    const marked = await Promise.all(wrong.map(async (key) => ((await deps.headroom.contradict(provider, key, { at, model }, askedAt)) ? [key] : [])));
    const accounts = marked.flat();
    if (accounts.length === 0) {
        return;
    }
    const sayKey = `${provider}\n${model}`;
    if (at - (saidAt.get(sayKey) ?? Number.NEGATIVE_INFINITY) >= SAY_EVERY_MS) {
        saidAt.set(sayKey, at);
        deps.logger.warn(
            { provider, model, accounts },
            "headroom: a turn was answered on a model its plan-limit readings said was spent, so those readings are wrong for it; re-reading. A provider that keeps doing this has changed what its usage endpoint reports",
        );
    }
    // Not watched: the endpoint's own read budget still holds, and a turn answered every few seconds must not outrun it.
    const [named] = accounts;
    const scope: RefreshScope = account === undefined || named === undefined ? { providers: [provider] } : { providers: [provider], account: named };
    await deps.headroom.refresh({ scope, maxAgeMs: 0 });
};
