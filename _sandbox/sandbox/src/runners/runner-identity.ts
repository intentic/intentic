import { join } from "node:path";
import { runnerEnrollUrl } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import type { RunnerModeEnv } from "./runner-mode.js";

/* WHO THIS RUNNER IS, the runner-side half of the pairing (the parent's half is runners-store.ts): which
 * sandbox it belongs to and the durable token every reconnect presents. On /history for the enrollment
 * files' reason: it outlives the container (a rebuilt runner must not need re-pairing), and it sits where no
 * tool the agent has can read it. The PAIRING in the container's env is single-use and burned at the parent
 * the moment this file first exists, so the env copy `docker inspect` shows is inert from then on. */

const RunnerIdentitySchema = z.object({
    parentUrl: z.string(),
    // The id the parent minted the pairing for; the name its views list this runner under.
    id: z.string(),
    token: z.string(),
    enrolledAt: z.number(),
});
export type RunnerIdentity = z.infer<typeof RunnerIdentitySchema>;

export const runnerIdentityPath = (historyRoot: string): string => join(historyRoot, "runner-identity.json");

export const readRunnerIdentity = async (historyRoot: string): Promise<RunnerIdentity | undefined> => {
    const file = jsonFile<RunnerIdentity | undefined>(runnerIdentityPath(historyRoot), {
        parse: (raw) => RunnerIdentitySchema.safeParse(raw).data,
        fallback: () => undefined,
        mode: 0o600,
    });
    return await file.read();
};

/* The identity, enrolling first when this container has never redeemed its pairing. Every boot after the
 * first takes the read path; a boot whose pairing was already spent AND whose identity file is gone is a
 * genuinely broken runner (a wiped /history under a reused container) and throws the sentence that says so. */
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
    const enrolled = z.object({ id: z.string(), runnerToken: z.string() }).parse(await response.json());
    const identity: RunnerIdentity = { parentUrl: env.parentUrl, id: enrolled.id, token: enrolled.runnerToken, enrolledAt: Date.now() };
    const file = jsonFile<RunnerIdentity | undefined>(runnerIdentityPath(historyRoot), {
        parse: (raw) => RunnerIdentitySchema.safeParse(raw).data,
        fallback: () => undefined,
        mode: 0o600,
    });
    await file.update(() => identity);
    return identity;
};
