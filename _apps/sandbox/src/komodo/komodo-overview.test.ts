import { describe, expect, test } from "vitest";
import type { KomodoAlert, KomodoDeploymentInfo, KomodoListItem, KomodoServerInfo, KomodoStackInfo } from "./komodo-client.js";
import { deployAlert, deployAlerts, deploymentResource, deployState, serverEntry, stackResource } from "./komodo-overview.js";

const BASE = "https://komodo.example.com";

const deployment = (info: KomodoDeploymentInfo): KomodoListItem<KomodoDeploymentInfo> => ({ id: "d1", name: "api", info });
const stack = (info: KomodoStackInfo): KomodoListItem<KomodoStackInfo> => ({ id: "s1", name: "web", info });
const server = (info: KomodoServerInfo): KomodoListItem<KomodoServerInfo> => ({ id: "sv1", name: "prod-1", info });

describe("deployState", () => {
    test("running keeps its meaning and every in-motion state reads as deploying", () => {
        expect(deployState("running")).toBe("running");
        // Teardown is a transition someone asked for, not a breakage — it belongs with deploying, and
        // crucially not with unhealthy.
        for (const state of ["deploying", "stopping", "removing"]) {
            expect(deployState(state)).toBe("deploying");
        }
    });

    // The design decision this whole surface rests on: being down is a LEVEL and says nothing about whether it
    // was meant to be, so `exited` is neutral. What says a running thing stopped is the alert log.
    test("every way of being down collapses onto the neutral `stopped`", () => {
        for (const state of ["exited", "stopped", "down", "paused", "created", "not_deployed"]) {
            expect(deployState(state)).toBe("stopped");
        }
    });

    test("only never-intentional states read as unhealthy", () => {
        for (const state of ["restarting", "dead", "unhealthy"]) {
            expect(deployState(state)).toBe("unhealthy");
        }
    });

    // A Komodo release adding a state word must not blank the board.
    test("an unmapped or absent state degrades to unknown", () => {
        expect(deployState("some_future_state")).toBe("unknown");
        expect(deployState(undefined)).toBe("unknown");
    });
});

describe("resources", () => {
    test("a deployment carries Komodo's own status prose and its deep link", () => {
        const resource = deploymentResource(
            BASE,
            deployment({ state: "running", status: "Up 4 days", image: "ghcr.io/acme/api:1.4.2", server_name: "prod-1" }),
        );
        expect(resource).toMatchObject({
            kind: "deployment",
            name: "api",
            state: "running",
            status: "Up 4 days",
            server: "prod-1",
            image: "ghcr.io/acme/api:1.4.2",
            updateAvailable: false,
            url: `${BASE}/deployments/d1`,
        });
    });

    test("a stack's update flag is the OR of its services, which ride the list call", () => {
        const resource = stackResource(
            BASE,
            stack({
                state: "running",
                services: [
                    { service: "api", image: "acme/api:1", update_available: false },
                    { service: "web", image: "acme/web:2", update_available: true },
                ],
            }),
        );
        expect(resource.updateAvailable).toBe(true);
        expect(resource.services).toEqual([
            { name: "api", image: "acme/api:1", updateAvailable: false },
            { name: "web", image: "acme/web:2", updateAvailable: true },
        ]);
        expect(resource.url).toBe(`${BASE}/stacks/s1`);
    });

    test("a resource Komodo has not placed still renders, without a server", () => {
        expect(deploymentResource(BASE, deployment({ state: "running" })).server).toBeUndefined();
    });
});

describe("servers", () => {
    test("GB usage becomes percentages and Ok becomes ok", () => {
        const entry = serverEntry(
            BASE,
            server({ state: "Ok", stats: { cpu_perc: 22.4, mem_used_gb: 8, mem_total_gb: 16, disk_used_gb: 94, disk_total_gb: 100 } }),
        );
        expect(entry).toMatchObject({ name: "prod-1", state: "ok", cpuPercent: 22, memPercent: 50, diskPercent: 94, url: `${BASE}/servers/sv1` });
    });

    // A state we cannot interpret must not be drawn as healthy — the safe direction is "unreachable".
    test("anything that is not Ok or Disabled reads as unreachable", () => {
        expect(serverEntry(BASE, server({ state: "NotOk" })).state).toBe("unreachable");
        expect(serverEntry(BASE, server({ state: "SomethingNew" })).state).toBe("unreachable");
        expect(serverEntry(BASE, server({})).state).toBe("unreachable");
        expect(serverEntry(BASE, server({ state: "Disabled" })).state).toBe("disabled");
    });

    test("a zero total means no stats rather than a full disk", () => {
        const entry = serverEntry(BASE, server({ state: "Ok", stats: { mem_used_gb: 0, mem_total_gb: 0 } }));
        expect(entry.memPercent).toBeUndefined();
    });
});

describe("alerts", () => {
    test("a container state change flattens to its transition, resource and host", () => {
        const alert = deployAlert(
            {
                _id: { $oid: "abc" },
                ts: 1_700,
                resolved: false,
                level: "CRITICAL",
                data: { type: "ContainerStateChange", data: { name: "api", server_name: "prod-1", from: "running", to: "restarting" } },
            },
            0,
        );
        expect(alert).toEqual({
            id: "abc",
            type: "ContainerStateChange",
            level: "critical",
            resolved: false,
            ts: 1_700,
            resource: "api",
            server: "prod-1",
            from: "running",
            to: "restarting",
        });
    });

    // A variant Komodo adds next is exactly the one worth surfacing, so it passes through unmapped.
    test("an unknown variant survives with its tag intact", () => {
        const alert = deployAlert({ ts: 1, data: { type: "SomethingKomodoAddedLater", data: { name: "api" } } }, 3);
        expect(alert.type).toBe("SomethingKomodoAddedLater");
        expect(alert.resource).toBe("api");
        // No mongo id: the fallback key still has to be stable and unique within one response.
        expect(alert.id).toBe("1-3");
    });

    test("a bare-string id and a missing level both degrade rather than throw", () => {
        const alert = deployAlert({ _id: "plain", ts: 5, data: { type: "ServerUnreachable", data: { name: "prod-1" } } }, 0);
        expect(alert.id).toBe("plain");
        expect(alert.level).toBe("warning");
        expect(alert.resolved).toBe(false);
    });

    test("the list comes back newest first", () => {
        const raw: KomodoAlert[] = [
            { ts: 100, data: { type: "ServerUnreachable", data: { name: "a" } } },
            { ts: 900, data: { type: "ServerUnreachable", data: { name: "b" } } },
        ];
        expect(deployAlerts(raw).map((alert) => alert.resource)).toEqual(["b", "a"]);
    });
});
