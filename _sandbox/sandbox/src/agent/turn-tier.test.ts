import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentTurn, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { turnTier } from "./turn-tier.js";

/* AUTOMATIC TIER SELECTION AS THE DAEMON SPENDS IT. The judge itself is pinned next to it in the contract
 * (prompt-complexity.test.ts); what these tests are about is the three things only this side decides: that
 * "shadow" really does change nothing, that a downgrade never costs an I/O it did not have to, and that a turn
 * whose provider has nothing cheaper is left alone rather than moved onto a guess. */

const CLAUDE = [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }];

const settingsWith = (over: Partial<SandboxSettings>): SandboxSettings => ({ ...SandboxSettingsSchema.parse({}), ...over });

const catalog = vi.fn(async () => ({ models: CLAUDE, default: "claude-opus-5" }));

const servicesWith = (): Services =>
    unstubbed<Services>("services", {
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
        providerCatalogs: { claude: { models: catalog } } as unknown as Services["providerCatalogs"],
    });

const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({ prompt: "what is a closure?", model: "claude-opus-5", ...over }) as AgentTurn;

const judge = (over: Partial<AgentTurn> = {}, settings: Partial<SandboxSettings> = {}, lastTier?: "fast" | "standard", hold = false) =>
    turnTier(servicesWith(), turn(over), { settings: settingsWith(settings), provider: "claude", lastTier, hold });

// --- the three modes ------------------------------------------------------------------------------------

test("off means the judge never runs at all, so the ledger records absence rather than a score", () => {
    // A turn nobody judged and a turn judged trivial are different rows, and a report that conflated them
    // would count the first as evidence for the second.
    return expect(judge({}, { autoTier: "off" })).resolves.toBeUndefined();
});

test("shadow judges everything and moves nothing", async () => {
    // The default, and the whole reason this can ship before anyone has a threshold to stand behind: it
    // records what it WOULD have done beside what the turn really cost.
    const tier = await judge({}, { autoTier: "shadow" });

    expect(tier?.verdict.tier).toBe(`fast`);
    expect(tier?.model).toBeUndefined();
});

test("shadow never reads a catalog, because it can never spend one", async () => {
    catalog.mockClear();
    await judge({}, { autoTier: "shadow" });

    expect(catalog).not.toHaveBeenCalled();
});

test("on moves an easy turn to the provider's cheap rung", async () => {
    const tier = await judge({}, { autoTier: "on" });

    expect(tier?.model).toBe(`claude-haiku-4-5`);
});

// --- what a downgrade costs to decide -------------------------------------------------------------------

test("a turn judged standard costs no catalog read even with routing switched on", async () => {
    // A mechanism that exists to save money must not spend any to decide. Only a turn that is BOTH eligible
    // and about to move is worth an I/O.
    catalog.mockClear();
    const tier = await judge({ prompt: "refactor the planner across every provider arm" }, { autoTier: "on" });

    expect(tier?.verdict.tier).toBe(`standard`);
    expect(tier?.model).toBeUndefined();
    expect(catalog).not.toHaveBeenCalled();
});

test("a turn that named no model has no ceiling to be cheaper than, and reads no catalog either", async () => {
    catalog.mockClear();
    const tier = await judge({ model: undefined }, { autoTier: "on" });

    expect(tier?.model).toBeUndefined();
    expect(catalog).not.toHaveBeenCalled();
});

// --- leaving the turn alone -----------------------------------------------------------------------------

test("a user already on the cheap rung is left where they are", async () => {
    const tier = await judge({ model: "claude-haiku-4-5" }, { autoTier: "on" });

    expect(tier?.verdict.tier).toBe(`fast`);
    expect(tier?.model).toBeUndefined();
});

test("an unreadable catalog leaves the turn on its own model rather than failing it", async () => {
    // The whole feature is optional and its fallback is the model the user asked for, which is never wrong,
    // only dearer. A catalog fault must not become the reason a turn did not run.
    catalog.mockRejectedValueOnce(new Error("offline"));
    const tier = await judge({}, { autoTier: "on" });

    expect(tier?.verdict.tier).toBe(`fast`);
    expect(tier?.model).toBeUndefined();
});

test("an endpoint provider gets pins only, never a guess about somebody else's price list", async () => {
    const services = servicesWith();
    const auto = await turnTier(services, turn(), {
        settings: settingsWith({ autoTier: "on" }),
        provider: "endpoint/mine",
        lastTier: undefined,
        hold: false,
    });
    const pinned = await turnTier(services, turn(), {
        settings: settingsWith({ autoTier: "on", autoFastModels: ["endpoint/mine:my-haiku-1"] }),
        provider: "endpoint/mine",
        lastTier: undefined,
        hold: false,
    });

    expect(auto?.model).toBeUndefined();
    expect(pinned?.model).toBe(`my-haiku-1`);
});

// --- the one input that cannot come from the request -----------------------------------------------------

test("the previous turn's verdict reaches the judge, so a deceptive follow-up is not downgraded", async () => {
    const cold = await judge({ prompt: "list the exports" }, { autoTier: "on" }, undefined);
    const warm = await judge({ prompt: "list the exports" }, { autoTier: "on" }, "standard");

    expect(cold?.model).toBe(`claude-haiku-4-5`);
    expect(warm?.model).toBeUndefined();
});

test("a screenshot is never downgraded, whatever the question about it", async () => {
    const tier = await judge({ prompt: "what is this?", attachments: [`${WORKSPACE_ROOT}/shot.png`] }, { autoTier: "on" });

    expect(tier?.verdict.rules).toContain(`images`);
    expect(tier?.model).toBeUndefined();
});

// --- the veto --------------------------------------------------------------------------------------------

test("the hold names the model it declined but marks it held, so nothing runs it and the chat can still say it", async () => {
    // The model is resolved and returned so the notice can say what the veto declined; `held` is what tells
    // the caller (and through it the ledger's tierDenied) that the user overruled a substitution that would
    // otherwise have happened.
    const tier = await judge({}, { autoTier: "on" }, undefined, true);

    expect(tier?.verdict.tier).toBe(`fast`);
    expect(tier?.model).toBe(`claude-haiku-4-5`);
    expect(tier?.held).toBe(true);
});

test("the hold is never reported when there was nothing to veto", async () => {
    // A standard verdict under a hold is not a denial: recording one would count turns where the user's
    // choice was irrelevant as evidence the judge was overruled.
    const standard = await judge({ prompt: "refactor the planner across every provider arm" }, { autoTier: "on" }, undefined, true);
    const shadow = await judge({}, { autoTier: "shadow" }, undefined, true);

    expect(standard?.held).toBeUndefined();
    expect(shadow?.held).toBeUndefined();
});
