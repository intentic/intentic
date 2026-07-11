import { linearize } from "@intentic/graph";
import { expect, test } from "vitest";
import { graph } from "./__fixtures__/deploy.config.js";
import { expectedGraph } from "./__fixtures__/deploy.graph.js";

test("declaration compiles to the expected desired-state graph", () => {
    expect(graph).toEqual(expectedGraph);
});

test("derived order is a valid topological linearization of the bootstrap", () => {
    const order = linearize(graph);
    const at = (id: string): number => order.indexOf(id);

    // Invariant: every node appears after all of its dependencies.
    for (const [id, node] of Object.entries(graph.resources)) {
        for (const dep of node.dependsOn) {
            expect(at(dep)).toBeLessThan(at(id));
        }
    }

    // It is a permutation of the resource ids (nothing dropped or duplicated).
    expect([...order].toSorted()).toEqual(Object.keys(graph.resources).toSorted());

    // Sanity on the headline phases: host -> git -> app deployment, and the platform tunnel comes up before
    // the control plane that reaches Forgejo/Komodo through its public routes.
    expect(at("host")).toBeLessThan(at("host-git"));
    expect(at("host-git")).toBeLessThan(at("my-app.production"));
    expect(at("host-tunnel")).toBeLessThan(at("my-app.production"));
});

test("a ref edge serializes correctly", () => {
    expect(graph.resources["host-git-runner"]?.inputs["token"]).toEqual({ $ref: "host-git.runnerToken" });
    expect(graph.resources["host-git-runner"]?.dependsOn).toContain("host-git");
});

test("secrets serialize and are never literals", () => {
    expect(graph.resources["host"]?.inputs["sshKey"]).toEqual({ $secret: { source: "env", key: "HOST_SSH_KEY" } });
    expect(graph.resources["my-app.staging"]?.inputs["env"]).toEqual({ DATABASE_URL: { $secret: { source: "env", key: "STAGING_DATABASE_URL" } } });
});
