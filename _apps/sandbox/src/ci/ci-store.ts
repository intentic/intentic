import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// The CI module's daemon-recorded state (<workspace>/.intentic/ci.json): the per-sandbox webhook secret and
// the last TERMINAL conclusion per repo+branch — what makes a success after a failure read as `pipeline_fixed`
// across daemon restarts. It carries a secret, so the file rides the CONTROL_PLANE_ENTRIES denylist
// (workspace-files.ts) like capabilities.json.

// Branches come and go; without pruning a busy workspace's file grows forever. Oldest-touched entries drop
// past this — a branch quiet for that long has no meaningful "was failing" memory anyway.
const CONCLUSIONS_KEPT = 200;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });
const CiStateSchema = z.object({
    secret: z.string().min(1),
    // Keyed "<repo>\n<branch>" — \n can appear in neither side, so the compound key can't collide.
    conclusions: z.record(z.string(), ConclusionSchema),
    // When the owner last LOOKED at the pipelines view. Lives here rather than in a browser, on the same
    // reasoning the agents registry records `seenAt` daemon-side: whether a breakage has been seen is a fact
    // about the work, so clearing site data or picking up the phone must not resurrect a badge already dealt
    // with. One timestamp for the whole surface — the view shows every repo at once, so looking at it is one
    // act of reading, not one per run.
    seenAt: z.number().optional(),
});
type CiState = z.infer<typeof CiStateSchema>;

export interface CiStore {
    // The webhook secret, minted on first read and stable after — hook registrations and signature checks
    // must agree across boots.
    readonly secret: () => Promise<string>;
    readonly lastConclusion: (repo: string, branch: string) => Promise<"success" | "failed" | undefined>;
    readonly recordConclusion: (repo: string, branch: string, status: "success" | "failed", at: number) => Promise<void>;
    // Undefined until the view has been opened once — which reads as "everything is news", the right answer
    // for a surface the owner has never looked at.
    readonly seenAt: () => Promise<number | undefined>;
    readonly markSeen: (at: number) => Promise<void>;
}

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

export const fileCiStore = (path: string): CiStore => {
    const read = async (): Promise<CiState | undefined> => {
        try {
            const parsed = CiStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    };
    const write = async (state: CiState): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 });
    };
    const readOrInit = async (): Promise<CiState> => {
        const current = await read();
        if (current !== undefined) {
            return current;
        }
        const fresh: CiState = { secret: randomBytes(32).toString("hex"), conclusions: {} };
        await write(fresh);
        return fresh;
    };
    return {
        secret: async () => (await readOrInit()).secret,
        lastConclusion: async (repo, branch) => (await read())?.conclusions[keyOf(repo, branch)]?.status,
        recordConclusion: async (repo, branch, status, at) => {
            const state = await readOrInit();
            state.conclusions[keyOf(repo, branch)] = { status, at };
            const keys = Object.keys(state.conclusions);
            if (keys.length > CONCLUSIONS_KEPT) {
                for (const stale of keys
                    .toSorted((a, b) => (state.conclusions[a]?.at ?? 0) - (state.conclusions[b]?.at ?? 0))
                    .slice(0, keys.length - CONCLUSIONS_KEPT)) {
                    delete state.conclusions[stale];
                }
            }
            await write(state);
        },
        seenAt: async () => (await read())?.seenAt,
        markSeen: async (at) => {
            const state = await readOrInit();
            state.seenAt = at;
            await write(state);
        },
    };
};
