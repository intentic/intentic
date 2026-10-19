import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodebaseHealth, HealthRequest } from "@intentic/iq-engine";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { sharedChoreSignals } from "./chore-signals.js";

// The rail badge and the panel list at once. A reading of a repo is shared only with a caller that asked before it
// began, so whatever either is shown was read after it asked; one begun earlier is waited out and read again.

// The iq half held open per call until the test lets it go, counting the readings each repo got.
const heldIq = () => {
    const begun: string[] = [];
    const releases: (() => void)[] = [];
    const health = async ({ scope }: HealthRequest): Promise<CodebaseHealth> => {
        begun.push(scope.repo ?? "");
        await new Promise<void>((resolve) => releases.push(resolve));
        return { hotspots: [], modules: [], totals: { files: begun.length, symbols: 0, complexity: 0, hotspots: 0 }, freshness: { state: "fresh" } };
    };
    const services = unstubbed<Pick<Services, "iq" | "workspace">>("services", {
        iq: unstubbed<Services["iq"]>("iq", { health }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "chores-shared-")) }),
    });
    return { services, begun, release: () => releases.shift()?.() };
};

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 1));

test("a reading begun after a caller asked is shared with it, and one begun before is read again once it is done", async () => {
    const { services, begun, release } = heldIq();
    const shared = sharedChoreSignals(services);

    const badge = shared.asked();
    const badgeFirst = shared.of("a", badge);
    await settle();
    // The panel asks while the badge's reading of `a` is under way: that reading began first, so it is not the panel's.
    const panel = shared.asked();
    const panelFirst = shared.of("a", panel);
    await settle();
    expect(begun).toEqual(["a"]);
    release();
    const badgeA = await badgeFirst;
    await settle();
    expect(begun).toEqual(["a", "a"]);
    release();
    const panelA = await panelFirst;
    expect(panelA).not.toBe(badgeA);
    expect(panelA.totals.files).toBe(2);

    // The badge moves on to `b` after the panel asked: that reading is the panel's as much as the badge's.
    const badgeSecond = shared.of("b", badge);
    const panelSecond = shared.of("b", panel);
    await settle();
    expect(begun).toEqual(["a", "a", "b"]);
    release();
    expect(await panelSecond).toBe(await badgeSecond);
});

test("everyone who asked while a reading was under way shares the one that follows it", async () => {
    const { services, begun, release } = heldIq();
    const shared = sharedChoreSignals(services);
    const under = shared.of("a", shared.asked());
    await settle();
    const late = [shared.of("a", shared.asked()), shared.of("a", shared.asked()), shared.of("a", shared.asked())];
    release();
    await under;
    await settle();
    release();
    const answers = await Promise.all(late);
    expect(begun).toEqual(["a", "a"]);
    expect(new Set(answers).size).toBe(1);
    // Nothing is held once no one is waiting: the next caller begins its own.
    const after = shared.of("a", shared.asked());
    await settle();
    release();
    await after;
    expect(begun).toEqual(["a", "a", "a"]);
});
