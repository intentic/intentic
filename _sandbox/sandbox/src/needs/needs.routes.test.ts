import type { Need, NeedAnswer } from "@intentic/sandbox-contract/schemas/needs";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import { memberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { Needs } from "./needs.js";
import { createNeedsRoutes, type NeedsRoutesDeps } from "./needs.routes.js";
import { opt } from "../opt.js";
import { provenTurnHeaders } from "../seams/workload-stamp.testing.js";

// A release is the one need its gate answers rather than the tier: the owner names its approvers from the whole roster,
// so a viewer named on it must be able to release it, through a door of its own that takes nothing but a release.

const need = (subject: Need["subject"]): Need => ({
    id: "need-1",
    conversationId: "conv-1",
    subject,
    title: "Release reddit-work",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
});

const as = (email: string, role: MemberTier): OrpcContext => ({
    headers: new Headers(),
    method: "POST",
    url: "/needs/need-1/release",
    identity: { email, tier: role, methods: ["google"] },
});

const routesOver = (held: Need, maintainer = false) => {
    const answers: { readonly answer: NeedAnswer; readonly email: string | undefined; readonly maintainer?: true }[] = [];
    const deps: NeedsRoutesDeps = {
        needs: unstubbed<Needs>("needs", {
            get: async () => held,
            answer: async (_id, answer, by) => {
                answers.push({ answer, email: by.email, ...opt("maintainer", by.maintainer) });
                return { ...held, status: answer.kind === "decline" ? "declined" : "met" };
            },
        }),
        grants: unstubbed<NeedsRoutesDeps["grants"]>("grants", {}),
        visible: () => true,
        maintains: async () => maintainer,
    };
    return { routes: createNeedsRoutes(deps), answers };
};

const RELEASE = need({ kind: "release", subject: "reddit-work", approvers: ["rin@example.com"] });

describe("needs.release", () => {
    test("is floored where every member reaches it, while the other answers stay the operating tier's", () => {
        expect(memberRefusal({ tier: "viewer" }, "POST", "/needs/need-1/release")).toBeUndefined();
        expect(memberRefusal({ tier: "viewer" }, "POST", "/needs/need-1/answer")).toEqual({ error: "maintainer access required", floor: "maintainer", reason: "floor" });
        expect(memberRefusal({ tier: "guest" }, "POST", "/needs/need-1/release")).toEqual({ error: "not open to a guest member", floor: "viewer", reason: "guest" });
    });

    test("carries a named viewer's release and decline to the need, which decides who may answer", async () => {
        const { routes, answers } = routesOver(RELEASE);
        expect(await call(routes.release, { id: "need-1", answer: "release" }, { context: as("rin@example.com", "viewer") })).toMatchObject({ status: "met" });
        expect(await call(routes.release, { id: "need-1", answer: "decline" }, { context: as("rin@example.com", "viewer") })).toMatchObject({ status: "declined" });
        expect(answers).toEqual([
            { answer: { kind: "release" }, email: "rin@example.com" },
            { answer: { kind: "decline" }, email: "rin@example.com" },
        ]);
    });

    test("answers nothing but a release, so the door widens no other need", async () => {
        const { routes, answers } = routesOver(need({ kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg" }));
        await expect(call(routes.release, { id: "need-1", answer: "release" }, { context: as("rin@example.com", "viewer") })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
        expect(answers).toEqual([]);
    });
});

// (2026-11-22) A host-power card's yes changes one of the owner's computers, so its kind asks whether the request's own
// bearer clears the maintainer floor, as the Devices view's door does; the answer route says so on the answerer.
describe("needs.answer", () => {
    const POWER = need({ kind: "host-power", device: "rog", findings: [], dueAt: 1 });

    test("says the answerer is a maintainer only when the request's own bearer clears that floor", async () => {
        const signedIn = routesOver(POWER, true);
        await call(signedIn.routes.answer, { id: "need-1", answer: { kind: "approve" } }, { context: as("owner@example.com", "owner") });
        expect(signedIn.answers).toEqual([{ answer: { kind: "approve" }, email: "owner@example.com", maintainer: true }]);
        // A machine credential the route admits: no identity, and no bearer that clears the floor.
        const panel = routesOver(POWER, false);
        await call(panel.routes.answer, { id: "need-1", answer: { kind: "approve" } }, { context: { headers: new Headers(), method: "POST", url: "/needs/need-1/answer" } });
        expect(panel.answers).toEqual([{ answer: { kind: "approve" }, email: undefined }]);
    });
});

// Every turn presents the same agent token: the conversation an agent's shell names is believed only with its turn's
// proof, and one naming none raises a need in the one live turn but takes back or reads none of its.
describe("an agent's shell", () => {
    const shell = (headers: Record<string, string>): OrpcContext => ({ headers: new Headers({ "x-intentic-agent": "agent-token", ...headers }), method: "POST", url: "/needs/need-1/withdraw" });
    const withdrawn: (string | undefined)[] = [];
    const routes = createNeedsRoutes({
        needs: unstubbed<Needs>("needs", {
            withdraw: async (_id, conversationId) => {
                withdrawn.push(conversationId);
                return { ...RELEASE, status: "cancelled" };
            },
            mine: async () => [RELEASE],
        }),
        grants: unstubbed<NeedsRoutesDeps["grants"]>("grants", {}),
        visible: () => true,
        maintains: async () => false,
    });

    test("withdraws as the conversation it proves, and is refused for a bare name or none", async () => {
        await call(routes.withdraw, { id: "need-1" }, { context: shell(provenTurnHeaders("conv-1")) });
        await expect(call(routes.withdraw, { id: "need-1" }, { context: shell({ "x-intentic-conversation": "conv-1" }) })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining('names conversation "conv-1" without the proof its turn carries'),
        });
        await expect(call(routes.withdraw, { id: "need-1" }, { context: shell({}) })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(withdrawn).toEqual(["conv-1"]);
    });

    test("lists its own needs only when it proves which turn it is", async () => {
        expect(await call(routes.mine, undefined, { context: shell(provenTurnHeaders("conv-1")) })).toEqual({ needs: [RELEASE] });
        expect(await call(routes.mine, undefined, { context: shell({}) })).toEqual({ needs: [] });
    });
});
