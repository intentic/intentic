import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EnrollHostInput, InventoryEntry } from "@intentic/sandbox-contract";
import { hostSshKeyVar } from "@intentic/scaffold";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { upsertEnv } from "../secrets/secrets.routes.js";
import { createConfigStore } from "./config-store.js";
import { hasManagedEntry, upsertManagedEntry } from "./managed-region.js";

// Register a deploy-target host from the connect-host script's POST /enroll: write its SSH key (and, on the first
// host, the Cloudflare token) to desired-state/.env, and upsert the i.have.host (+ i.have.cloudflare
// "cf") into deploy.config.ts. Idempotent by name — re-running the script updates the address/key. Requires
// DevOps (the desired-state repo); the config write independently throws PRECONDITION_FAILED if intent is absent.
export const enrollHost = async (services: Services, input: EnrollHostInput): Promise<void> => {
    const desiredState = services.workspace.repos["desired-state"];
    if (!existsSync(desiredState)) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active — activate it before enrolling a host." });
    }

    // Secrets → desired-state/.env (mode 0600), the same file `apply` reloads (mirrors secrets.routes).
    const envPath = join(desiredState, ".env");
    const writeSecret = async (key: string, value: string): Promise<void> => {
        const current = await readFile(envPath, "utf8").catch(() => "");
        await mkdir(dirname(envPath), { recursive: true });
        await writeFile(envPath, upsertEnv(current, key, value), { mode: 0o600 });
    };
    await writeSecret(hostSshKeyVar(input.name), input.sshKey);
    if (input.cfToken !== undefined) {
        await writeSecret("CLOUDFLARE_API_TOKEN", input.cfToken);
    }

    // Host (+ cf on first enroll) → deploy.config.ts managed region.
    const config = createConfigStore(services);
    const host: InventoryEntry = {
        kind: "backend",
        provider: "host",
        name: input.name,
        values: { address: input.address, user: input.user, port: input.port, ...(input.via !== "direct" ? { via: input.via } : {}) },
    };
    await upsertManagedEntry(config, host, `chore(intentic): enroll host "${input.name}"`);
    if (input.cfToken !== undefined && !(await hasManagedEntry(config, "cf"))) {
        await upsertManagedEntry(
            config,
            { kind: "backend", provider: "cloudflare", name: "cf", values: input.cfZone !== undefined ? { zone: input.cfZone } : {} },
            "chore(intentic): register cloudflare",
        );
    }
};
