import { type RunnerPresentation, runnerTitle } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { ORPCError } from "@orpc/client";
import { Hono } from "hono";
import type { Services } from "../../composition.js";
import { type RunnerClient, runnerSummaries } from "../runner-peer.js";
import { runnerDefinitionRawRoutes } from "../runner.routes.js";
import { pushRunnerPresentation } from "./runner-label.js";

// A runner's name for people: kept by the parent beside the enrollment (its id never changes), listed with it, and told
// to the runner so its machine lists it by that name and says whose it is.

interface Enrolled {
    id: string;
    host?: string | undefined;
    label?: string | undefined;
}

const fakeServices = (enrolled: Enrolled[], options: { online?: boolean; ownName?: string; present?: (input: RunnerPresentation) => Promise<{ ok: true }> } = {}) => {
    const told: RunnerPresentation[] = [];
    const logged: string[] = [];
    const record = (_fields: unknown, message?: string): void => void logged.push(message ?? "");
    const present =
        options.present ??
        (async (input: RunnerPresentation) => {
            told.push(input);
            return { ok: true as const };
        });
    // Only the seams the routes, the list and the push read; any other throws by name.
    const services = unstubbed<Services>("services", {
        auth: undefined,
        config: unstubbed<Services["config"]>("config", {
            sandbox: unstubbed<Services["config"]["sandbox"]>("config.sandbox", { image: "", baseImage: "", baseDigest: "", channel: "", environmentHash: "" }),
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        runners: unstubbed<Services["runners"]>("runners", {
            list: async () => enrolled.map((runner) => ({ ...runner, card: runner.id })),
            enrolled: async (id: string) => enrolled.some((runner) => runner.id === id),
            amend: async (id: string, patch: Partial<Enrolled>) => {
                const at = enrolled.findIndex((runner) => runner.id === id);
                enrolled[at] = { ...enrolled[at]!, ...patch };
            },
        }),
        runnerHub: unstubbed<Services["runnerHub"]>("runnerHub", {
            state: () => ({ online: options.online === true }),
            client: () => (options.online === true ? unstubbed<RunnerClient>("runner", { present }) : undefined),
        }),
        presentation: unstubbed<Services["presentation"]>("presentation", {
            held: async () => (options.ownName === undefined ? undefined : { name: options.ownName, at: "2026-11-21T00:00:00.000Z" }),
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: record, warn: record }),
    });
    return { services, told, logged, enrolled };
};

const relabel = async (services: Services, id: string, body: unknown): Promise<Response> => {
    const app = new Hono();
    app.post("/system/runners/:id/label", runnerDefinitionRawRoutes(services)["POST /system/runners/{id}/label"]);
    return await app.request(`/system/runners/${id}/label`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
};

test("a runner reads by its label, and by its id when it has none", () => {
    expect(runnerTitle({ id: "omen", label: "Gaming PC" })).toBe("Gaming PC");
    expect(runnerTitle({ id: "omen" })).toBe("omen");
    expect(runnerTitle({ id: "omen", label: "  " })).toBe("omen");
});

test("the runner list carries each runner's label beside its id", async () => {
    const { services } = fakeServices([{ id: "omen", host: "omen", label: "Gaming PC" }, { id: "rig" }]);
    const listed = await runnerSummaries(services);
    expect(listed.map((runner) => [runner.id, runner.label])).toEqual([
        ["omen", "Gaming PC"],
        ["rig", undefined],
    ]);
});

test("a rename is kept beside the enrollment and told to a connected runner with this sandbox's own name", async () => {
    const { services, told, enrolled } = fakeServices([{ id: "omen", host: "omen" }], { online: true, ownName: "intentic" });
    const response = await relabel(services, "omen", { label: "  Gaming PC " });
    expect(response.status).toBe(200);
    expect(enrolled[0]).toEqual({ id: "omen", host: "omen", label: "Gaming PC" });
    expect(told).toEqual([{ name: "Gaming PC", parentName: "intentic" }]);
});

test("an empty label, or one equal to the id, clears it and the runner reads by its id again", async () => {
    const { services, told, enrolled } = fakeServices([{ id: "omen", label: "Gaming PC" }], { online: true });
    expect((await relabel(services, "omen", { label: "" })).status).toBe(200);
    expect(enrolled[0]?.label).toBeUndefined();
    await relabel(services, "omen", { label: "omen" });
    expect(enrolled[0]?.label).toBeUndefined();
    expect(told).toEqual([{ name: "omen" }, { name: "omen" }]);
});

test("a rename of a runner this sandbox does not have, or with no label in it, is refused and changes nothing", async () => {
    const { services, enrolled } = fakeServices([{ id: "omen" }]);
    expect((await relabel(services, "rig", { label: "x" })).status).toBe(404);
    expect((await relabel(services, "omen", { name: "x" })).status).toBe(400);
    expect((await relabel(services, "omen", { label: "x".repeat(65) })).status).toBe(400);
    expect(enrolled).toEqual([{ id: "omen" }]);
});

test("a runner that is away is renamed all the same, and told on its next connect", async () => {
    const { services, told, enrolled } = fakeServices([{ id: "omen" }], { online: false });
    expect((await relabel(services, "omen", { label: "Gaming PC" })).status).toBe(200);
    expect(enrolled[0]?.label).toBe("Gaming PC");
    expect(told).toEqual([]);
});

test("a runner too old to be told its name is logged and left as it is, never thrown at", async () => {
    const { services, logged } = fakeServices([{ id: "omen" }], {
        online: true,
        present: async () => {
            throw new ORPCError("NOT_FOUND");
        },
    });
    await expect(pushRunnerPresentation(services, "omen")).resolves.toBeUndefined();
    expect(logged).toEqual(["runners: this runner is too old to be told its name"]);
});
