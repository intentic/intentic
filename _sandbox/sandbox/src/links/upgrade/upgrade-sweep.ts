import { LinkConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Logger } from "pino";
import { upgradeRoutePairing } from "../../account-routing/messages/pairing-upgrade.js";
import { routeClientOf } from "../../account-routing/route-client.js";
import { routeSecretsOf } from "../../account-routing/route-secrets.js";
import type { Services } from "../../composition.js";
import type { UpgradeOutcome } from "../../s2s/contacts/contact-upgrade.js";
import { type LinkCard, upgradeLinkCard } from "./link-upgrade-out.js";

// THE ASKING SIDES OF BOTH UPGRADES, run by themselves (docs/architecture/messages.md, "Across versions"): every `link`
// card this sandbox holds, and every route pairing secret, is offered to its far side as a contact, at boot and again
// on a backoff until it is one, and a card at once when a turn mounts it (its first use since the last try). A far side
// from before contacts is asked again daily, so one that updates is upgraded then; until then it is left on the old path.
// What a try came to is kept in memory: a restart tries everything once more, which costs one identity read each.

const SWEEP_MS = 60_000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;
// A card's use asks again at most this often.
const USE_AGAIN_MS = 10 * 60 * 1000;

export interface UpgradeSweepDeps {
    readonly cards: () => Promise<readonly LinkCard[]>;
    readonly routes: () => Promise<readonly { readonly target: string; readonly person: string }[]>;
    readonly upgradeCard: (card: LinkCard) => Promise<UpgradeOutcome>;
    readonly upgradeRoute: (held: { readonly target: string; readonly person: string }) => Promise<UpgradeOutcome>;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
}

interface Tried {
    readonly at: number;
    readonly next: number;
    readonly misses: number;
}

// When to ask again after an outcome: soon and ever less often for a far side not reached, daily for one too old or refusing.
const nextOf = (outcome: UpgradeOutcome, at: number, misses: number): number =>
    outcome.kind === "later" ? at + Math.min(FIRST_RETRY_MS * 2 ** misses, MAX_RETRY_MS) : at + DAILY_MS;

export interface UpgradeSweep {
    // Every card and pairing whose time has come, tried once each.
    readonly sweep: () => Promise<void>;
    // A turn mounted this card: tried now unless it was within the last ten minutes.
    readonly used: (cardId: string) => void;
}

export const createUpgradeSweep = (deps: UpgradeSweepDeps): UpgradeSweep => {
    const tried = new Map<string, Tried>();
    let running: Promise<void> | undefined;
    const attempt = async (key: string, run: () => Promise<UpgradeOutcome>): Promise<void> => {
        const at = deps.now();
        const outcome = await run().catch((error: Error): UpgradeOutcome => ({ kind: "later", why: error.message }));
        if (outcome.kind === "upgraded") {
            tried.delete(key);
            return;
        }
        const misses = (tried.get(key)?.misses ?? 0) + 1;
        tried.set(key, { at, next: nextOf(outcome, at, misses - 1), misses });
        if (outcome.kind === "refused") {
            deps.logger.warn({ key, why: outcome.why }, "upgrade into a contact refused; asked again tomorrow");
        }
    };
    const due = (key: string): boolean => (tried.get(key)?.next ?? 0) <= deps.now();
    const once = async (): Promise<void> => {
        for (const card of await deps.cards()) {
            const key = `card:${card.id}`;
            if (due(key)) {
                await attempt(key, () => deps.upgradeCard(card));
            }
        }
        for (const held of await deps.routes()) {
            const key = `route:${held.target}\u0000${held.person.toLowerCase()}`;
            if (due(key)) {
                await attempt(key, () => deps.upgradeRoute(held));
            }
        }
    };
    // One sweep at a time: a card's use during one waits for it rather than asking twice.
    const sweep = async (): Promise<void> => {
        running ??= once().finally(() => {
            running = undefined;
        });
        return running;
    };
    return {
        sweep,
        used: (cardId) => {
            const key = `card:${cardId}`;
            const last = tried.get(key);
            if (last !== undefined && deps.now() - last.at < USE_AGAIN_MS) {
                return;
            }
            tried.set(key, { at: deps.now(), next: 0, misses: last?.misses ?? 0 });
            void sweep().catch((error: Error) => deps.logger.warn({ err: error }, "upgrade sweep failed"));
        },
    };
};

/** This daemon's link cards, as the sweep reads them: only the ones whose settings parse. */
const linkCardsOf = async (services: Pick<Services, "capabilities">): Promise<readonly LinkCard[]> =>
    (await services.capabilities.list()).flatMap((capability) => {
        if (capability.kind !== "link") {
            return [];
        }
        const config = LinkConfigSchema.safeParse(capability.config);
        return config.success ? [{ id: capability.id, config: config.data }] : [];
    });

export type UpgradeServices = Pick<Services, "capabilities" | "s2s" | "linkedChildren" | "config" | "workspace" | "logger">;

/** The sweep over this daemon: its link cards and its route secrets. */
const upgradeSweepOf = (services: UpgradeServices): UpgradeSweep => {
    const core = services.s2s.core;
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
    const secrets = routeSecretsOf(services);
    return createUpgradeSweep({
        cards: () => linkCardsOf(services),
        routes: () => secrets.list(),
        upgradeCard: (card) =>
            upgradeLinkCard({ core, capabilities: services.capabilities, children: services.linkedChildren, fetch: fetcher, logger: services.logger }, card),
        upgradeRoute: (held) =>
            upgradeRoutePairing(
                {
                    core,
                    secrets,
                    locate: (target, person) => routeClientOf(services).routeTo({ scope: "read", person, sandbox: target }),
                    fetch: fetcher,
                    logger: services.logger,
                },
                held,
            ),
        now: Date.now,
        logger: services.logger,
    });
};

// allow(module-state): the one sweep this daemon runs, which a turn mounting a link card tells of the card's use.
let current: UpgradeSweep | undefined;

/** A turn mounted this link card (link-mounts.ts): its first use since the last try asks its far side again. */
export const noteLinkCardUsed = (cardId: string): void => current?.used(cardId);

/** Sweeps at boot and every minute after; answers the stop. Unref'd: it never holds the daemon up. */
export const startUpgradeSweep = (services: UpgradeServices): (() => void) => {
    const sweep = upgradeSweepOf(services);
    current = sweep;
    const tick = (): void => {
        void sweep.sweep().catch((error: Error) => services.logger.warn({ err: error }, "upgrade sweep failed"));
    };
    const timer = setInterval(tick, SWEEP_MS);
    timer.unref();
    tick();
    return () => {
        clearInterval(timer);
        if (current === sweep) {
            current = undefined;
        }
    };
};
