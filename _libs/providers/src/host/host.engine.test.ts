import { apply } from "@intentic/engine";
import { compile, env, toNodeMap } from "@intentic/graph";
import { expect, test } from "vitest";
import type { SshExecutor } from "../core/ssh.js";
import { createHostProvider } from "./host.js";

// A reachable, Docker-ready host: docker version succeeds, the route command yields the internal ip.
const reachable: SshExecutor = {
    connect: async () => ({
        exec: async (command) =>
            command.includes("docker") ? { stdout: "24.0.0", stderr: "", code: 0 } : { stdout: "10.0.0.5\n", stderr: "", code: 0 },
        dispose: async () => {},
    }),
};

test("host node: the engine reconciles an owned host to noop and records its facts", async () => {
    // The host is authored inventory (address/user literals, the SSH key an env secret); build its node
    // directly to exercise the host provider in isolation.
    const graph = compile(
        toNodeMap([
            {
                id: "host",
                type: "host",
                inputs: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") },
                explicitDependsOn: [],
            },
        ]),
    );

    const result = await apply(graph, {
        providers: { host: createHostProvider(reachable) },
        env: { HOST_SSH_KEY: "key-material" },
        log: () => {},
    });

    // An owned host already exists, so read returns it and the engine reports noop (not create).
    expect(result.steps).toEqual([{ id: "host", type: "host", action: "noop" }]);
    expect(result.outputs["host"]).toEqual({ internalIp: "10.0.0.5", publicIp: "203.0.113.10" });
});
