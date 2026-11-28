import type { LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { UpgradeOutcome } from "../../s2s/contacts/contact-upgrade.js";
import { createUpgradeSweep } from "./upgrade-sweep.js";

// When the asking sides of both upgrades are tried: everything at once at boot; a far side not reached again after a
// minute, doubling; one too old for contacts (or refusing) daily; a card again when a turn mounts it, at most every ten
// minutes; and nothing once it is a contact.

const MINUTE = 60_000;
const config: LinkConfig = { url: "https://ops.example", token: "ilk_x", name: "ops" };

const harness = (outcomes: { card: UpgradeOutcome["kind"]; route: UpgradeOutcome["kind"] }) => {
    let now = 1_000_000;
    const tries: string[] = [];
    const outcomeOf = (kind: UpgradeOutcome["kind"]): UpgradeOutcome => (kind === "upgraded" ? { kind, contact: "c-1" } : { kind, why: "as the suite says" });
    const sweep = createUpgradeSweep({
        cards: async () => [{ id: "ops", config }],
        routes: async () => [{ target: "bbbbbbbbbbbb", person: "ada@acme.test" }],
        upgradeCard: async (card) => {
            tries.push(`card:${card.id}`);
            return outcomeOf(outcomes.card);
        },
        upgradeRoute: async (held) => {
            tries.push(`route:${held.person}`);
            return outcomeOf(outcomes.route);
        },
        now: () => now,
        logger: { info: () => undefined, warn: () => undefined },
    });
    return {
        sweep,
        tries,
        at: (ms: number) => {
            now += ms;
        },
    };
};

test("tries everything at boot, a far side not reached again after a minute and then two, one too old for contacts daily", async () => {
    const { sweep, tries, at } = harness({ card: "later", route: "old" });
    await sweep.sweep();
    expect(tries).toEqual(["card:ops", "route:ada@acme.test"]);

    at(MINUTE - 1);
    await sweep.sweep();
    expect(tries).toHaveLength(2);
    at(1);
    await sweep.sweep();
    expect(tries.slice(2)).toEqual(["card:ops"]);
    // The second miss waits two minutes.
    at(2 * MINUTE - 1);
    await sweep.sweep();
    expect(tries).toHaveLength(3);
    at(1);
    await sweep.sweep();
    expect(tries.slice(3)).toEqual(["card:ops"]);

    // The pairing toward a daemon from before is asked again a day after its first try, not sooner.
    at(24 * 60 * MINUTE - 3 * MINUTE - 1);
    await sweep.sweep();
    expect(tries.filter((one) => one.startsWith("route:"))).toHaveLength(1);
    at(1);
    await sweep.sweep();
    expect(tries.filter((one) => one.startsWith("route:"))).toHaveLength(2);
});

test("a card's use asks again at once, at most every ten minutes", async () => {
    const { sweep, tries, at } = harness({ card: "old", route: "old" });
    await sweep.sweep();
    expect(tries).toEqual(["card:ops", "route:ada@acme.test"]);

    // Used within ten minutes of the last try: nothing.
    at(9 * MINUTE);
    sweep.used("ops");
    await sweep.sweep();
    expect(tries).toHaveLength(2);

    // Used past them: tried now, though its day is far off.
    at(MINUTE);
    sweep.used("ops");
    await sweep.sweep();
    expect(tries.slice(2)).toEqual(["card:ops"]);
});
