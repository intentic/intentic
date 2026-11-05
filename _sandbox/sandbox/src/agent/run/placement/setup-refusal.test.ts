import type { BudgetSnapshot } from "../../../workload/resource-budget.js";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { NamespaceSetupError } from "../../../workload/namespace-holder.js";
import { BROKEN_SENTENCE, setupNotes, type SetupSink, setupRefusalOf, setupRefusalSentence, withSetupRefusal } from "./setup-refusal.js";

const GIB = 1024 ** 3;

// What the sandbox read at 11:00 on 2026-10-13, when a turn's setup stalled.
const LOADED = { stallPercent: 7.36, ioStallPercent: 41.86, swapBytes: 7.2 * GIB };

test("the refusal says what the sandbox measured, and that it goes again by itself only where it will", () => {
    expect(setupRefusalSentence(LOADED, true)).toBe(
        "This conversation's copy of the workspace could not be set up in time: the sandbox was too busy (everything waited on memory 7% and on the disk 42% of the last ten seconds, with 7.2 GiB in swap). It goes again by itself once the sandbox has had room for a while.",
    );
    // Nothing measured worth naming: it says only that the sandbox was slow, and promises nothing it will not do.
    expect(setupRefusalSentence({ stallPercent: 0.2, ioStallPercent: 0, swapBytes: 0 }, false)).toBe(
        "This conversation's copy of the workspace could not be set up in time: the sandbox was too slow to prepare it.",
    );
    expect(setupRefusalSentence(undefined, false)).toBe("This conversation's copy of the workspace could not be set up in time: the sandbox was too slow to prepare it.");
});

describe("the placement's refusal for a holder that did not come up in time", () => {
    const stalled = new NamespaceSetupError("stalled", "namespace setup stalled: no progress for 10.0 s (no mount reported done)", {
        steps: 0,
        awakeMs: 10_000,
        frozenMs: 12_008,
    });
    const servicesWith = (memoryPolicy: "wait" | "resend", warnings: unknown[][]) =>
        unstubbed<Pick<Services, "agents" | "sandboxSettings" | "resources" | "logger">>("services", {
            agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
                get: async () => unstubbed<Awaited<ReturnType<Services["sandboxSettings"]["get"]>>>("settings", { memoryPolicy }),
            }),
            resources: unstubbed<Services["resources"]>("resources", {
                snapshot: async () => unstubbed<BudgetSnapshot>("snapshot", { reading: { limitBytes: 18 * GIB, usedBytes: 9 * GIB, oomKills: undefined, ...LOADED } }),
            }),
            logger: unstubbed<Services["logger"]>("logger", { warn: (...args: unknown[]) => { warnings.push(args); } }),
        });
    const turn = (unattended: boolean): RoutedTurn => unstubbed<RoutedTurn>("turn", { conversationId: "mellow-harbor-rk0i", prompt: "x", unattended });

    it("is coded, worded for a person and logged with the holder's own facts", async () => {
        const warnings: unknown[][] = [];
        const refusal = await setupRefusalOf(servicesWith("resend", warnings), turn(false), stalled);
        expect(refusal.code).toBe("workspace-setup");
        expect(refusal.refused).toContain("It goes again by itself");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.[0]).toMatchObject({ conversationId: "mellow-harbor-rk0i", failure: "stalled", frozenMs: 12_008, ioStallPercent: 41.86 });
    });

    it("promises no resend where nothing will send it: a conversation that waits for a press, or a turn nobody typed", async () => {
        expect((await setupRefusalOf(servicesWith("wait", []), turn(false), stalled)).refused).not.toContain("by itself");
        expect((await setupRefusalOf(servicesWith("resend", []), turn(true), stalled)).refused).not.toContain("by itself");
    });
});

// 2026-11-05: the holder answered, and what it answered was the kernel refusing a mount. Uncoded, that read as a turn
// that stopped short, and Continue ran into it twenty times; coded, it is held at the door and the chat offers a way out.
describe("the placement's refusal for a holder that refused past its repair", () => {
    const said = "namespace setup exited 1: bwrap: Can't make overlay mount on (null) with options upperdir=/proc/self/fd/6,workdir=/proc/self/fd/9,lowerdir=/proc/self/fd/10,userxattr: Invalid argument (no mount reported done)";
    const refused = new NamespaceSetupError("exited", said, { steps: 0, awakeMs: 40, frozenMs: 0 });
    const services = (warnings: unknown[][]) =>
        unstubbed<Pick<Services, "agents" | "sandboxSettings" | "resources" | "logger">>("services", {
            logger: unstubbed<Services["logger"]>("logger", { warn: (...args: unknown[]) => { warnings.push(args); } }),
        });
    const turn = unstubbed<RoutedTurn>("turn", { conversationId: "pawel-overlay", prompt: "continue" });

    it("is coded as one that repeats, in the sandbox's own sentence with the holder's words behind it", async () => {
        const warnings: unknown[][] = [];
        const answer = await withSetupRefusal(services(warnings), turn, () => Promise.reject(refused));
        expect(answer).toEqual({ code: "workspace-broken", refused: `${BROKEN_SENTENCE} (${said})` });
        expect(warnings[0]?.[0]).toMatchObject({ conversationId: "pawel-overlay", failure: "exited", reason: said });
    });

    it("leaves any other placement failure its own error", async () => {
        const other = new Error("checkout gone");
        await expect(withSetupRefusal(services([]), turn, () => Promise.reject(other))).rejects.toBe(other);
    });

    it("records the repair the anchor made on the way up, for the turn to say", () => {
        const sink: SetupSink = {};
        setupNotes(services([]), turn, sink).onRepair(2, refused);
        expect(sink).toEqual({ repaired: 2 });
    });
});
