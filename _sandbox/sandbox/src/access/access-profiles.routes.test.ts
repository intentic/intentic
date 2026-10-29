import type { ManageRight } from "@intentic/sandbox-contract/schemas/members";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createAuthConnections } from "../auth/connections.js";
import { createMediaTickets } from "../auth/tokens/media-tickets.js";
import { createWsTickets } from "../auth/tokens/ws-tickets.js";
import {
    memoryAccessProfiles,
    memoryAreasStore,
    memoryMembersStore,
    memoryPersonasStore,
    memoryServicesStore,
} from "../harness/route-stores.testing.js";
import { createAccessProfilesRoutes } from "./access-profiles.routes.js";

// A profile is a grant several people share: saving it writes every holder's row again and closes what they hold, and
// answers with the tier each now has. Whoever runs people and access writes one, never an organisation's.

const contextAs = (role: MemberRole, manages: readonly ManageRight[] = [], email = role === "owner" ? "owner@example.com" : "max@example.com"): OrpcContext => ({
    headers: new Headers(),
    method: "POST",
    url: "/access/profiles",
    identity: { email, role, methods: ["google"], manages },
});

const PERSONAS: Persona[] = [{ id: "helper", capabilities: [], workspace: { startIn: "support" } }];

const routes = () => {
    const connections = createAuthConnections();
    const revoked: (string | undefined)[] = [];
    connections.onRevoke((email) => revoked.push(email));
    const services = {
        accessProfiles: memoryAccessProfiles([{ id: "readers", agents: "off" }], [{ id: "clerk", agents: "run", tools: { shell: false } }]),
        services: memoryServicesStore([{ id: "bot", steward: "owner@example.com", profile: "readers" }]),
        members: memoryMembersStore([
            { email: "fay@example.com", role: "viewer", agents: "off", profile: "readers" },
            { email: "vic@example.com", role: "viewer" },
        ]),
        areas: memoryAreasStore([{ id: "support", folders: ["support"] }]),
        personas: memoryPersonasStore(PERSONAS),
        auth: unstubbed<NonNullable<Services["auth"]>>("auth", { connections }),
        wsTickets: createWsTickets(),
        mediaTickets: createMediaTickets(),
    };
    return { profiles: createAccessProfilesRoutes(services), revoked, services };
};

test("saving a profile rewrites its holders' rows, closes their connections and answers their new tier", async () => {
    const { profiles, revoked, services } = routes();
    const saved = await call(profiles.save, { id: "readers", agents: "run", tools: { web: false } }, { context: contextAs("owner") });
    expect(saved).toEqual({ ok: true, holders: [{ email: "fay@example.com", role: "collaborator" }] });
    expect(revoked).toEqual(["fay@example.com"]);
    expect((await services.members.list()).find((member) => member.email === "fay@example.com")).toEqual({
        email: "fay@example.com",
        role: "collaborator",
        agents: "run",
        tools: { web: false },
        profile: "readers",
    });
});

test("whoever runs people and access writes a profile, never the one they hold, and nobody here writes an organisation's", async () => {
    const { profiles } = routes();
    await expect(call(profiles.save, { id: "readers" }, { context: contextAs("collaborator") })).rejects.toThrow(
        "only someone who runs people and access decides what an access profile lets its holders reach",
    );
    await expect(call(profiles.save, { id: "readers", agents: "off" }, { context: contextAs("maintainer") })).resolves.toMatchObject({ ok: true });
    await expect(call(profiles.save, { id: "readers", agents: "off" }, { context: contextAs("collaborator", ["people"]) })).resolves.toMatchObject({ ok: true });
    await expect(call(profiles.save, { id: "readers", agents: "off" }, { context: contextAs("viewer", ["people"], "fay@example.com") })).rejects.toThrow(
        `"readers" is the profile your own access comes from`,
    );
    await expect(call(profiles.save, { id: "clerk" }, { context: contextAs("owner") })).rejects.toThrow(
        `"clerk" is your organisation's profile: it is changed on the organisation's console, not here`,
    );
});

test("a profile no grant could make, or naming an area nobody wrote, is refused", async () => {
    const { profiles } = routes();
    await expect(call(profiles.save, { id: "chat", agents: "chat" }, { context: contextAs("owner") })).rejects.toThrow(
        "chatting with assistants needs at least one area: the assistants that work there are the ones they talk to",
    );
    await expect(call(profiles.save, { id: "lost", areas: ["nowhere"] }, { context: contextAs("owner") })).rejects.toThrow("no such area: nowhere");
    await expect(call(profiles.save, { id: "guests", agents: "chat", areas: ["support"], assistants: ["nobody"] }, { context: contextAs("owner") })).rejects.toThrow(
        "no such assistant: nobody",
    );
});

test("a profile still held by a person or a service is not deleted, and says by whom", async () => {
    const { profiles, services } = routes();
    await expect(call(profiles.remove, { id: "readers" }, { context: contextAs("owner") })).rejects.toThrow(
        `still held by fay@example.com, the service "bot"; move them off it first`,
    );
    await services.members.add("fay@example.com", { role: "viewer", agents: "off" });
    await services.services.upsert({ id: "bot", steward: "owner@example.com" });
    await expect(call(profiles.remove, { id: "readers" }, { context: contextAs("owner") })).resolves.toEqual({ ok: true });
});
