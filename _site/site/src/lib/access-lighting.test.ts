import { accessMapScene as scene } from "@intentic/site-content/access-map";
import { accessLightings, listed, nodeIdsOf, reachedBy } from "./access-lighting";

const lights = accessLightings(scene);
const principal = (id: string) => scene.principals.find((entry) => entry.id === id);

describe("a way in's lighting", () => {
    it("lights a writer's one area, the persona homed there and only the keys her grant lists", () => {
        const ada = lights.get("who:ada");
        expect(ada?.nodes["area:support"]).toBe("edit");
        expect(ada?.nodes["area:storefront"]).toBeUndefined();
        expect(ada?.nodes["persona:maya"]).toBe("use");
        expect(ada?.nodes["cap:stripe"]).toBeUndefined();
        expect(ada?.nodes.secrets).toBeUndefined();
        expect(ada?.tags["area:support"]).toBe("edits");
        expect(ada?.counts.services).toBe("2 of 5");
        expect(ada?.wires).toMatchObject({ "p:ada": "on", "c:people": "on", "g:services": "on" });
        expect(ada?.wires["g:machines"]).toBeUndefined();
    });

    it("names the persona on a room a guest reaches only through it, and dashes the groups it reaches that way", () => {
        const kai = lights.get("who:kai");
        expect(kai?.tags["area:support"]).toBe("as Maya");
        expect(kai?.wires["g:services"]).toBe("through");
    });

    it("leaves everything outside dark for a token that only reads", () => {
        const board = lights.get("who:status-board");
        expect(Object.keys(board?.wires ?? {}).filter((key) => key.startsWith("g:"))).toEqual([]);
        expect(board?.tags.rest).toBe("reads");
    });
});

describe("a thing's lighting", () => {
    it("lights who reaches a connection, dashing those who reach it only as a persona, and ties the persona that carries it", () => {
        const stripe = lights.get("cap:stripe");
        expect(stripe?.principals).toEqual(["you", "kai", "nightly-ci", "helpdesk"]);
        expect(stripe?.wires).toMatchObject({
            "p:you": "on",
            "p:kai": "through",
            "p:helpdesk": "through",
            "c:sandboxes": "through",
            "g:services": "on",
        });
        expect(stripe?.nodes).toMatchObject({ "cap:stripe": "focus", "persona:maya": "tie" });
    });

    it("ties an area to the personas homed in it", () => {
        expect(lights.get("area:storefront")?.nodes["persona:owen"]).toBe("tie");
    });

    it("words who reaches it strongest first, as a sentence", () => {
        expect(reachedBy(scene, "area:support").map((row) => [row.label, listed(row.names)])).toEqual([
            ["Changes it", "You and Ada"],
            ["Only reads it", "nightly CI, status board and helpdesk"],
            ["Only as a persona", "Kai"],
        ]);
    });

    it("has a lighting for every thing the drawing stands", () => {
        expect(nodeIdsOf(scene).filter((id) => !lights.has(id))).toEqual([]);
    });
});

// The sample is invented, but it must keep the rules the daemon enforces (the app's reachModel.ts).
describe("the sample keeps the daemon's rules", () => {
    it("lets only the owner and a writer change files by hand", () => {
        const editors = scene.principals.filter((entry) => Object.values(entry.reach).includes("edit")).map((entry) => entry.id);
        expect(editors).toEqual(["you", "ada"]);
    });

    it("gives a way in that acts as a persona no connection that persona does not carry", () => {
        for (const entry of scene.principals.filter((candidate) => candidate.actsAs !== undefined)) {
            const persona = scene.personas.find((card) => card.id === entry.actsAs);
            const connections = nodeIdsOf(scene).filter((id) => id.startsWith("cap:") && entry.reach[id] !== undefined);
            expect(connections.filter((id) => !persona?.allows.some((allowed) => allowed === id))).toEqual([]);
        }
    });

    it("reaches nothing outside the box for a way in that runs no turn", () => {
        const reader = principal("status-board");
        expect(nodeIdsOf(scene).filter((id) => reader?.reach[id] !== undefined && reader.reach[id] !== "see")).toEqual([]);
    });

    it("homes every persona in an area on the drawing", () => {
        expect(scene.personas.filter((persona) => !scene.areas.some((area) => area.id === persona.home))).toEqual([]);
    });
});
