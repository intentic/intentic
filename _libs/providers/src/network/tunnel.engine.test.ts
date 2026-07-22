import { apply } from "@intentic/engine";
import type { DesiredStateGraph } from "@intentic/graph";
import { expect, test } from "vitest";
import type { SshExecutor, SshResult } from "../core/ssh.js";
import { createHostProvider } from "../host/host.js";
import { createCfRouteProvider } from "./cf-route.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { createTunnelProvider } from "./tunnel.js";

// A stateful in-memory Cloudflare account: owns one zone, remembers the tunnel/ingress/DNS records the
// providers create so a second apply finds everything and reports noop.
const fakeCloudflare = (): CloudflareApi => {
    const tunnels = new Map<string, string>();
    const records = new Map<string, { id: string; content: string }>();
    let ingress: IngressRule[] | undefined;
    let seq = 0;
    return {
        getZone: async () => ({ id: "zone-123", accountId: "acct-1" }),
        listZones: async () => [{ id: "zone-123", name: "example.com", accountId: "acct-1" }],
        findTunnel: async ({ name }) => {
            const id = tunnels.get(name);
            return id === undefined ? undefined : { id };
        },
        createTunnel: async ({ name }) => {
            const id = `tunnel-${seq++}`;
            tunnels.set(name, id);
            return { id };
        },
        getTunnelToken: async () => "connector-token",
        getTunnelStatus: async () => "healthy",
        getTunnelIngress: async () => ingress,
        putTunnelIngress: async ({ ingress: next }) => {
            ingress = [...next];
        },
        findDnsRecord: async ({ name }) => records.get(name),
        createDnsRecord: async ({ name, content }) => {
            records.set(name, { id: `rec-${seq++}`, content });
        },
        updateDnsRecord: async ({ name, content, recordId }) => {
            records.set(name, { id: recordId, content });
        },
        deleteTunnel: async () => {},
        deleteDnsRecord: async () => {},
    };
};

// A stateful host shared by the host + tunnel providers: Docker-ready, default route -> 10.0.0.5, and it
// remembers the connector container once `docker run` has executed.
const fakeSsh = (): SshExecutor => {
    let running: string | undefined;
    let image: string | undefined;
    return {
        connect: async () => ({
            exec: async (command): Promise<SshResult> => {
                if (command.includes("docker version")) {
                    return { stdout: "24.0.0", stderr: "", code: 0 };
                }
                if (command.includes("ip -4 -o route")) {
                    return { stdout: "10.0.0.5\n", stderr: "", code: 0 };
                }
                if (command.includes("docker inspect")) {
                    return { stdout: running !== undefined ? (image ?? "") : "", stderr: "", code: 0 };
                }
                if (command.includes("docker ps")) {
                    return { stdout: running ?? "", stderr: "", code: 0 };
                }
                if (command.includes("docker run")) {
                    running = /--name (\S+)/.exec(command)?.[1];
                    image = /(\S+@sha256:[0-9a-f]+)/.exec(command)?.[1];
                    return { stdout: "container-id", stderr: "", code: 0 };
                }
                return { stdout: "", stderr: "", code: 0 };
            },
            dispose: async () => {},
        }),
    };
};

// host + cloudflare inventory, the host's tunnel (ingress -> internal service), and one cf-route whose
// CNAME targets the tunnel. Built by hand because i.want.app would pull in providerless platform nodes.
const graph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: {
            id: "host",
            type: "host",
            inputs: { address: "203.0.113.10", user: "deploy", sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } },
            dependsOn: [],
        },
        cf: {
            id: "cf",
            type: "cloudflare",
            inputs: { apiToken: { $secret: { source: "env", key: "CF_TOKEN" } }, zone: "example.com" },
            dependsOn: [],
        },
        "host-tunnel": {
            id: "host-tunnel",
            type: "tunnel",
            inputs: {
                name: "intentic-host",
                accountId: { $ref: "cf.accountId" },
                apiToken: { $secret: { source: "env", key: "CF_TOKEN" } },
                address: "203.0.113.10",
                user: "deploy",
                sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } },
                ingress: [{ hostname: "app.example.com", port: 3000 }],
                image: "cloudflare/cloudflared:2026.6.1@sha256:aaaa",
            },
            dependsOn: ["cf", "host"],
        },
        "cf-app-example-com": {
            id: "cf-app-example-com",
            type: "cf-route",
            inputs: {
                hostname: "app.example.com",
                zoneId: { $ref: "cf.zoneId" },
                apiToken: { $secret: { source: "env", key: "CF_TOKEN" } },
                cname: { $ref: "host-tunnel.cname" },
            },
            dependsOn: ["cf", "host-tunnel"],
        },
    },
};

const env = { HOST_SSH_KEY: "key-material", CF_TOKEN: "token-xyz" };

test("the engine wires host -> cloudflare -> tunnel -> cf-route, then is idempotent", async () => {
    const cloudflare = fakeCloudflare();
    const ssh = fakeSsh();
    const providers = {
        host: createHostProvider(ssh),
        cloudflare: createCloudflareProvider(cloudflare),
        tunnel: createTunnelProvider(cloudflare, ssh),
        "cf-route": createCfRouteProvider(cloudflare, async () => {}),
    };

    const first = await apply(graph, { providers, env, probe: async () => true, log: () => {} });
    // Owned host + zone read as existing (noop); the tunnel and its route are created this run.
    expect(first.steps).toEqual([
        { id: "host", type: "host", action: "noop" },
        { id: "cf", type: "cloudflare", action: "noop" },
        { id: "host-tunnel", type: "tunnel", action: "create" },
        { id: "cf-app-example-com", type: "cf-route", action: "create" },
    ]);
    expect(first.outputs["cf"]).toEqual({ zoneId: "zone-123", accountId: "acct-1" });
    expect(first.outputs["host-tunnel"]).toEqual({ tunnelId: "tunnel-0", cname: "tunnel-0.cfargotunnel.com" });
    expect(first.outputs["cf-app-example-com"]).toEqual({ url: "https://app.example.com" });

    // Same account + host: everything is found and converged => all noop.
    const second = await apply(graph, { providers, env, probe: async () => true, log: () => {} });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});
