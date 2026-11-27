import { SLEEP_WATCHES_MAX } from "@intentic/api-contract/ingress";
import { VAULTED } from "@intentic/sandbox-contract/policy/capability-secrets";
import { type SleepWatchCard, type SleepWatchSources, sleepWatchesOf } from "./sleep-watches.js";

// What a hosted machine hands the platform before it sleeps: a bot's token, only for a connection whose owner turned the
// card's consent on, whose card's extension owns the listener, while an automation listens on it, and never anything
// on a sandbox on somebody's own computer.

const NOW = Date.parse("2026-11-27T03:00:00Z");
const DISCORD = "intentic.discord";
const watch = { service: "discord" as const, credential: "botToken", consent: "wakeOnMention" };

const card = (id: string, config: Record<string, string | undefined>): SleepWatchCard => ({
    // SAFETY: a cli card's config is its card's own fields beside `provider`, which is all the hand-over reads.
    capability: { id, kind: "cli", config: { provider: "discord", botToken: `token-${id}`, wakeOnMention: "on", ...config } as never },
    declared: { watch, extension: DISCORD },
});

type Automation = SleepWatchSources["automations"][number];
const listening = (over: Partial<Automation> = {}): Automation => ({ enabled: true, trigger: { kind: "listener", provider: "discord" }, ...over });

const sources = (over: Partial<SleepWatchSources> = {}): SleepWatchSources => ({
    hosted: true,
    cards: [card("discord-team", {})],
    owners: new Map([["discord", DISCORD]]),
    automations: [listening()],
    now: NOW,
    ...over,
});

test("a consented connection with a listening automation hands its token over on a hosted machine", () => {
    expect(sleepWatchesOf(sources())).toEqual([{ service: "discord", connection: "discord-team", credential: "token-discord-team" }]);
});

test("nothing leaves without the owner's yes: consent off, unanswered, or anything but on", () => {
    for (const wakeOnMention of ["off", undefined, "", "yes"]) {
        expect(sleepWatchesOf(sources({ cards: [card("discord-team", { wakeOnMention })] }))).toEqual([]);
    }
});

test("nothing leaves a sandbox on somebody's own computer, consent or not", () => {
    expect(sleepWatchesOf(sources({ hosted: false }))).toEqual([]);
});

test("nothing leaves while no automation listens on the provider", () => {
    for (const automations of [
        [],
        [listening({ enabled: false })],
        [listening({ expiresAt: NOW - 1 })],
        [listening({ trigger: { kind: "listener", provider: "slack" } })],
        // SAFETY: a webhook trigger's other fields are not read; only its kind is.
        [{ enabled: true, trigger: { kind: "event" } } as Automation],
    ]) {
        expect(sleepWatchesOf(sources({ automations }))).toEqual([]);
    }
});

test("nothing leaves for a card that declares no watch, or whose extension does not own the provider's listener", () => {
    expect(sleepWatchesOf(sources({ cards: [{ capability: card("plain", {}).capability }] }))).toEqual([]);
    expect(sleepWatchesOf(sources({ owners: new Map([["discord", "someone.else"]]) }))).toEqual([]);
});

test("a token still in the vault, or none, is never handed over", () => {
    expect(sleepWatchesOf(sources({ cards: [card("vaulted", { botToken: VAULTED })] }))).toEqual([]);
    expect(sleepWatchesOf(sources({ cards: [card("empty", { botToken: "" })] }))).toEqual([]);
});

test("one bot shared by two cards is handed once, and no more than the contract's cap", () => {
    const shared = [card("a", { botToken: "same" }), card("b", { botToken: "same" })];
    expect(sleepWatchesOf(sources({ cards: shared })).map((each) => each.connection)).toEqual(["a"]);
    const many = Array.from({ length: SLEEP_WATCHES_MAX + 2 }, (_, index) => card(`bot-${String(index)}`, {}));
    expect(sleepWatchesOf(sources({ cards: many }))).toHaveLength(SLEEP_WATCHES_MAX);
});
