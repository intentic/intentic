import type { Need, RedirectNeed } from "@intentic/sandbox-contract/schemas/needs";
import { REDIRECT_WORDS_MAX } from "@intentic/sandbox-contract/schemas/needs";
import type { PersonOpening } from "../../account-routing/person-opening.js";
import type { RouteAnswer, RouteRequest } from "../../account-routing/route-client.js";
import { redirectNeed } from "./redirect-need.js";

// A message that reached the wrong sandbox: the agent names only where it belongs, the words are the daemon's copy of
// what the person typed, the target is the one the platform finds among the sandboxes that person is in, and only that
// person can send it on. Kept here wakes the conversation; sent on wakes nothing.

const OPS = { sandboxId: "bbbbbbbbbbbb", name: "ops", address: "https://sandbox-bbbbbbbbbbbb.sbx.test", pass: "sp1.x", expiresAt: "2026-11-25T12:10:00Z" };
const WORDS = "fix the login bug in acme/app";

const harness = (options: { readonly opening?: PersonOpening | undefined; readonly located?: RouteAnswer; readonly mayHandOn?: boolean; readonly claimed?: readonly string[] } = {}) => {
    const asked: RouteRequest[] = [];
    const kind = redirectNeed({
        opening: () => ("opening" in options ? options.opening : { email: "ada@acme.test", words: WORDS, attachments: 0, at: 1 }),
        mayHandOn: () => options.mayHandOn ?? true,
        normalize: (raw) => (raw.includes("/") ? raw.replace(/^https:\/\//u, "").replace(/\.git$/u, "") : undefined),
        claimedHere: async () => ({ ok: true, projects: options.claimed ?? [] }),
        locate: async (request) => {
            asked.push(request);
            return options.located ?? { ok: true, value: OPS };
        },
    });
    return { kind, asked };
};

const SUBJECT: RedirectNeed = { kind: "redirect", target: "bbbbbbbbbbbb", targetName: "ops", address: OPS.address, person: "ada@acme.test", words: WORDS };
const needOf = (subject: RedirectNeed = SUBJECT): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: undefined };

describe("redirectNeed", () => {
    it("raises a card carrying the person's own words to the sandbox the platform found for them by name", async () => {
        const { kind, asked } = harness();
        expect(await kind.resolve({ kind: "redirect", target: "ops" }, context)).toEqual({ kind: "raise", subject: SUBJECT, title: "Send this message on to ops" });
        expect(asked).toEqual([{ scope: "read", person: "ada@acme.test", sandbox: "ops" }]);
    });

    it("finds the target by a project's claim, and says when the claim is this sandbox's own", async () => {
        const { kind, asked } = harness();
        expect(await kind.resolve({ kind: "redirect", project: "https://github.com/acme/app.git" }, context)).toMatchObject({
            kind: "raise",
            subject: { target: "bbbbbbbbbbbb", project: "github.com/acme/app" },
        });
        expect(asked).toEqual([{ scope: "report", person: "ada@acme.test", project: "github.com/acme/app" }]);
        const here = harness({ claimed: ["github.com/acme/app"] });
        expect(await here.kind.resolve({ kind: "redirect", project: "github.com/acme/app" }, context)).toMatchObject({ kind: "refused", code: "here" });
        expect(here.asked).toEqual([]);
    });

    it("says how many files stay behind, and carries only the head of a message too long for the card", async () => {
        const long = "x".repeat(REDIRECT_WORDS_MAX + 10);
        const { kind } = harness({ opening: { email: "ada@acme.test", words: long, attachments: 2, at: 1 } });
        const resolved = await kind.resolve({ kind: "redirect", target: "ops" }, context);
        expect(resolved).toMatchObject({ kind: "raise", subject: { clipped: true, attachments: 2 } });
        expect(resolved.kind === "raise" && resolved.subject.kind === "redirect" ? resolved.subject.words.length : 0).toBe(REDIRECT_WORDS_MAX);
    });

    it("asks nothing without one place named, words a person typed, a turn that may hand on, or a target the platform finds", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "redirect" }, context)).toMatchObject({ kind: "refused", code: "invalid" });
        expect(await kind.resolve({ kind: "redirect", target: "ops", project: "github.com/acme/app" }, context)).toMatchObject({ kind: "refused", code: "invalid" });
        expect(await harness({ opening: undefined }).kind.resolve({ kind: "redirect", target: "ops" }, context)).toMatchObject({ kind: "refused", code: "no_words" });
        const filesOnly = harness({ opening: { email: "ada@acme.test", words: "  ", attachments: 1, at: 1 } });
        expect(await filesOnly.kind.resolve({ kind: "redirect", target: "ops" }, context)).toMatchObject({ kind: "refused", code: "no_words" });
        expect(await harness({ mayHandOn: false }).kind.resolve({ kind: "redirect", target: "ops" }, context)).toMatchObject({ kind: "refused", code: "outside" });
        const twins = harness({
            located: { ok: false, status: 409, message: "2 sandboxes you are in are called ops", candidates: [{ sandboxId: "b1", name: "ops" }, { sandboxId: "b2", name: "ops" }] },
        });
        const refused = await twins.kind.resolve({ kind: "redirect", target: "ops" }, context);
        expect(refused).toMatchObject({ kind: "refused", code: "unrouted" });
        expect(refused.kind === "refused" ? refused.message : "").toContain("ops (b1), ops (b2)");
    });

    it("is the author's alone to send on, met by their press, and wakes the conversation only when they keep it here", async () => {
        const { kind } = harness();
        expect(kind.mayAnswer?.(needOf(), { email: "owner@acme.test" })).toContain("Only ada@acme.test");
        expect(kind.mayAnswer?.(needOf(), { email: "Ada@Acme.test" })).toBeUndefined();
        expect(await kind.answer(needOf(), { kind: "approve" }, { email: "owner@acme.test" })).toMatchObject({ refused: expect.stringContaining("Only ada@acme.test") });
        expect(await kind.answer(needOf(), { kind: "approve" }, { email: "ada@acme.test" })).toMatchObject({ status: "met", result: expect.stringContaining("sent their message on to ops") });
        expect(await kind.check(needOf())).toBeUndefined();
        expect(kind.wakesOn).toBe("declined");
        expect(kind.nextTurn(needOf())).toBe(false);
    });

    it("is one card per target and message, so asking twice finds the first", () => {
        const { kind } = harness();
        expect(kind.key(SUBJECT)).toBe(kind.key({ ...SUBJECT }));
        expect(kind.key(SUBJECT)).not.toBe(kind.key({ ...SUBJECT, words: "another message" }));
        expect(kind.key(SUBJECT)).not.toBe(kind.key({ ...SUBJECT, target: "cccccccccccc" }));
    });
});
