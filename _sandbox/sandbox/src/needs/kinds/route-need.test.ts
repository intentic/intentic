import type { Need, RouteNeed } from "@intentic/sandbox-contract/schemas/needs";
import type { RouteAnswer } from "../../account-routing/route-client.js";
import { routeNeed } from "./route-need.js";

// A person's leave for this sandbox to act as them in another: the ask names the target and the daemon names the person
// (the one the raising conversation acts for), the card is raised only while no secret is held for the pair, only that
// person may answer, and the answer only confirms the secret their press kept here. A set stands in for the store.

const TARGET = { sandboxId: "bbbbbbbbbbbb", name: "app", address: "https://sandbox-bbbbbbbbbbbb.sbx.test", pass: "sp1.x", expiresAt: "2026-11-24T12:10:00Z" };

const harness = (options: { readonly person?: string | undefined; readonly located?: RouteAnswer } = {}) => {
    const held = new Set<string>();
    const located: string[] = [];
    const kind = routeNeed({
        personOf: async () => (options.person === undefined ? { refused: "this conversation acts for more than one person" } : { person: options.person }),
        locate: async (target, person, scope) => {
            located.push(`${target}:${person}:${scope}`);
            return options.located ?? { ok: true, value: TARGET };
        },
        held: async (target, person) => held.has(`${target}:${person}`),
        self: () => "aaaaaaaaaaaa",
    });
    return { kind, held, located };
};

const SUBJECT: RouteNeed = {
    kind: "route",
    target: "bbbbbbbbbbbb",
    targetName: "app",
    person: "ada@acme.test",
    scopes: ["drop", "read", "task"],
    address: TARGET.address,
    from: "aaaaaaaaaaaa",
};
const needOf = (subject: RouteNeed = SUBJECT): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: undefined };

describe("routeNeed", () => {
    it("raises a card for the conversation's one person and the target the platform found for them", async () => {
        const { kind, located } = harness({ person: "ada@acme.test" });
        expect(await kind.resolve({ kind: "route", target: "app" }, context)).toEqual({ kind: "raise", subject: SUBJECT, title: "Let this sandbox act as ada@acme.test in app" });
        expect(located).toEqual(["app:ada@acme.test:drop"]);
    });

    it("is met at once when the pair is already held, and a report alone needs nothing", async () => {
        const { kind, held } = harness({ person: "ada@acme.test" });
        held.add("bbbbbbbbbbbb:ada@acme.test");
        expect(await kind.resolve({ kind: "route", target: "app", scopes: ["task"] }, context)).toMatchObject({ kind: "met" });
        expect(await kind.resolve({ kind: "route", target: "app", scopes: ["report"] }, context)).toMatchObject({ kind: "met" });
    });

    it("refuses to ask for a conversation acting for several people, or a target the platform cannot find", async () => {
        expect(await harness().kind.resolve({ kind: "route", target: "app" }, context)).toMatchObject({ kind: "refused", code: "no_person" });
        const lost = harness({ person: "ada@acme.test", located: { ok: false, status: 404, message: "no sandbox you reach is called app" } });
        expect(await lost.kind.resolve({ kind: "route", target: "app" }, context)).toMatchObject({ kind: "refused", code: "unrouted" });
    });

    it("is the person's alone to answer, and met only once the secret their press kept is here", async () => {
        const { kind, held } = harness({ person: "ada@acme.test" });
        expect(kind.mayAnswer?.(needOf(), { email: "owner@acme.test" })).toContain("Only ada@acme.test");
        expect(kind.mayAnswer?.(needOf(), { email: "Ada@Acme.test" })).toBeUndefined();
        expect(await kind.answer(needOf(), { kind: "approve" }, { email: "owner@acme.test" })).toMatchObject({ refused: expect.stringContaining("Only") });
        expect(await kind.answer(needOf(), { kind: "approve" }, { email: "ada@acme.test" })).toMatchObject({ refused: expect.stringContaining("press Allow again") });
        expect(await kind.check(needOf())).toBeUndefined();
        held.add("bbbbbbbbbbbb:ada@acme.test");
        expect(await kind.answer(needOf(), { kind: "approve" }, { email: "ada@acme.test" })).toMatchObject({ status: "met" });
        expect(await kind.check(needOf())).toMatchObject({ result: expect.stringContaining("ada@acme.test") });
    });

    it("keys one card per target and person", () => {
        const { kind } = harness();
        expect(kind.key(SUBJECT)).toBe(kind.key({ ...SUBJECT, scopes: ["drop"], person: "ADA@acme.test" }));
        expect(kind.key(SUBJECT)).not.toBe(kind.key({ ...SUBJECT, person: "bo@acme.test" }));
    });
});
