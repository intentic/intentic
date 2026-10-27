import type { Need, NeedAnswer } from "@intentic/sandbox-contract/schemas/needs";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { memberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { Needs } from "./needs.js";
import { createNeedsRoutes, type NeedsRoutesDeps } from "./needs.routes.js";

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

const as = (email: string, role: MemberRole): OrpcContext => ({
    headers: new Headers(),
    method: "POST",
    url: "/needs/need-1/release",
    identity: { email, role, methods: ["google"] },
});

const routesOver = (held: Need) => {
    const answers: { readonly answer: NeedAnswer; readonly email: string | undefined }[] = [];
    const deps: NeedsRoutesDeps = {
        needs: unstubbed<Needs>("needs", {
            get: async () => held,
            answer: async (_id, answer, by) => {
                answers.push({ answer, email: by.email });
                return { ...held, status: answer.kind === "decline" ? "declined" : "met" };
            },
        }),
        grants: unstubbed<NeedsRoutesDeps["grants"]>("grants", {}),
        visible: () => true,
    };
    return { routes: createNeedsRoutes(deps), answers };
};

const RELEASE = need({ kind: "release", subject: "reddit-work", approvers: ["rin@example.com"] });

describe("needs.release", () => {
    test("is floored where every member reaches it, while the other answers stay the operating tier's", () => {
        expect(memberRefusal({ role: "viewer" }, "POST", "/needs/need-1/release")).toBeUndefined();
        expect(memberRefusal({ role: "viewer" }, "POST", "/needs/need-1/answer")).toEqual({ error: "maintainer access required", floor: "maintainer", reason: "floor" });
        expect(memberRefusal({ role: "guest" }, "POST", "/needs/need-1/release")).toEqual({ error: "not open to a guest member", floor: "viewer", reason: "guest" });
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
