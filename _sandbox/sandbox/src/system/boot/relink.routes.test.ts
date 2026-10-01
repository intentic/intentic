import type { RelinkAnswer } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { ForbiddenError } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import type { Adoption, Announcer } from "./announce.js";
import { createRelinkRoute } from "./relink.routes.js";

// The owner's Reconnect: ownership-gated, a plain re-registration without a ticket, an adoption with one, and refused
// on a sandbox nobody owns yet.

type RelinkServices = Pick<Services, "auth" | "announcer" | "ownerEmail">;

const registered: RelinkAnswer = { announce: { state: "registered", at: 0 } };

const stage = (over: { owner?: string | undefined; gate?: Services["auth"] } = {}) => {
    const relink = jest.fn<(adoption?: Adoption) => Promise<RelinkAnswer>>(async () => registered);
    const services: RelinkServices = {
        auth: over.gate,
        announcer: unstubbed<Announcer>("announcer", { relink }),
        ownerEmail: async () => ("owner" in over ? over.owner : "owner@example.com"),
    };
    const app = new Hono<AppEnv>();
    app.post("/platform/relink", createRelinkRoute(services));
    // A Reconnect with nothing to adopt sends no body at all, as the browser does.
    const press = (body?: Record<string, unknown>) => {
        const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }
        return app.request("/platform/relink", init);
    };
    return { relink, press };
};

describe("POST /platform/relink", () => {
    it("re-registers without a ticket, adopting nothing", async () => {
        const { relink, press } = stage();
        const res = await press();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(registered);
        expect(relink.mock.calls).toEqual([[]]);
    });

    it("hands a ticket on as an adoption by the bound owner, with what the browser remembers", async () => {
        const { relink, press } = stage();
        await press({ ticket: "at1.ticket", name: "intentic", image: "data:image/webp;base64,AAAA" });
        expect(relink.mock.calls).toEqual([[{ ticket: "at1.ticket", owner: "owner@example.com", name: "intentic", image: "data:image/webp;base64,AAAA" }]]);
    });

    it("refuses an adoption on a sandbox nobody owns yet", async () => {
        const { relink, press } = stage({ owner: undefined });
        const res = await press({ ticket: "at1.ticket" });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "this sandbox has no owner yet: set it up instead" });
        expect(relink).not.toHaveBeenCalled();
    });

    it("refuses a malformed body", async () => {
        const { press } = stage();
        const res = await press({ ticket: 42 });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "a relink names at most an adoption ticket, a name and an image" });
    });

    it("lets only the owner press it", async () => {
        const gate = unstubbed<NonNullable<Services["auth"]>>("auth", {
            authorizeOwner: async () => {
                throw new ForbiddenError("only this sandbox's owner can do that");
            },
        });
        const { relink, press } = stage({ gate });
        const res = await press();
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "only this sandbox's owner can do that" });
        expect(relink).not.toHaveBeenCalled();
    });
});
