import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import type { JsonValue } from "@intentic/base/json";
import { startEngineDockerProxy } from "./engine-docker-proxy.js";
import { run } from "./run.js";

/** An ic home and a Docker context of the tier's own; no context or container on the runner is changed. */
export const engineDockerContext = async (root: string): Promise<{ env: Record<string, string>; close: () => Promise<void> }> => {
    const endpoint = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeoutMs: 30_000 });
    const host = endpoint.stdout.trim();
    if (endpoint.code !== 0 || !host.startsWith("npipe:////./pipe/")) {
        throw new Error(`the engine move tier needs Docker Desktop's Windows pipe: ${host}`);
    }
    const proxy = await startEngineDockerProxy({ socketPath: host.replace("npipe:////./pipe/", "\\\\.\\pipe\\") });
    try {
        const config = join(root, "docker-context");
        await mkdir(config, { recursive: true });
        const original = join(process.env["DOCKER_CONFIG"] ?? join(homedir(), ".docker"), "config.json");
        // Keep the registry login the workflow established, without changing its original context or exposing credentials.
        const content = await readFile(original, "utf8").catch((error) => {
            if (!isMissing(error)) { throw error; }
            return "{}";
        });
        // SAFETY: this is Docker's persisted config object. Preserve its opaque settings; only select a new context.
        const settings = JSON.parse(content) as Record<string, JsonValue>;
        await writeFile(join(config, "config.json"), JSON.stringify({ ...settings, currentContext: "default" }));
        const env = { DOCKER_CONFIG: config };
        for (const args of [["context", "create", "engine-smoke", "--docker", `host=${proxy.host}`], ["context", "use", "engine-smoke"]]) {
            const result = await run("docker", args, { env, timeoutMs: 30_000 });
            if (result.code !== 0) { throw new Error(`could not prepare the engine smoke's Docker context: ${result.stderr}`); }
        }
        return { env, close: proxy.close };
    } catch (error) {
        await proxy.close();
        throw error;
    }
};
