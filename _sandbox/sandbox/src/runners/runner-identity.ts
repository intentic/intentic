import { join } from "node:path";
import { runnerEnrollUrl } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";
import type { RunnerModeEnv } from "./runner-mode.js";

/* WHO THIS RUNNER IS, the runner-side half of the pairing (the parent's half is the peer store, runners/runner-peer.ts). */

const RunnerIdentitySchema = z.object({
    parentUrl: z.string(),
    // The id the parent minted the pairing for; the name its views list this runner under.
    id: z.string(),
    token: z.string(),
    enrolledAt: z.number(),
});
export type RunnerIdentity = z.infer<typeof RunnerIdentitySchema>;

// One document for the two handles below, which open the same file.
export const runnerIdentityDocument = defineDocument({ root: "history", path: "runner-identity.json", schema: RunnerIdentitySchema });

export const runnerIdentityPath = (historyRoot: string): string => join(historyRoot, "runner-identity.json");

export const readRunnerIdentity = async (historyRoot: string): Promise<RunnerIdentity | undefined> => {
    const file = jsonFile<RunnerIdentity | undefined>(runnerIdentityPath(historyRoot), {
        parse: (raw) => RunnerIdentitySchema.safeParse(raw).data,
        fallback: () => undefined,
        mode: 0o600,
        document: runnerIdentityDocument,
    });
    return await file.read();
};

/* The identity, enrolling first when this container has never redeemed its pairing. */
export const ensureRunnerIdentity = async (historyRoot: string, env: RunnerModeEnv): Promise<RunnerIdentity> => {
    const existing = await readRunnerIdentity(historyRoot);
    if (existing !== undefined) {
        return existing;
    }
    const response = await fetch(runnerEnrollUrl(env.parentUrl), { method: "POST", headers: { "x-intentic-pair": env.pairToken } });
    if (!response.ok) {
        throw new Error(
            `enrolling with the parent sandbox failed (${response.status}): the pairing expired or was already used. Mint a fresh one there and recreate this runner.`,
        );
    }
    const enrolled = z.object({ id: z.string(), token: z.string() }).parse(await response.json());
    const identity: RunnerIdentity = { parentUrl: env.parentUrl, id: enrolled.id, token: enrolled.token, enrolledAt: Date.now() };
    const file = jsonFile<RunnerIdentity | undefined>(runnerIdentityPath(historyRoot), {
        parse: (raw) => RunnerIdentitySchema.safeParse(raw).data,
        fallback: () => undefined,
        mode: 0o600,
        document: runnerIdentityDocument,
    });
    await file.update(() => identity);
    return identity;
};
