// A row belongs only if its keys come from setup, their absence is settled, and other env proves intent.
// Add a row here, add it to `ic sandbox doctor`'s `classify_public` too: the two tables are not kept in sync.

/** `enables` and `lost` render verbatim to the user: word them for the product, not the env. */
export interface ContainerRequirement {
    readonly key: string;
    readonly requires: readonly string[];
    // Absent `given` evidence means this sandbox never had the capability: not a fault, just unconfigured.
    readonly given: readonly string[];
    // Row stays silent if any `unless` key is present: an alternate mechanism already satisfies the evidence.
    readonly unless?: readonly string[];
    readonly enables: string;
    readonly lost: string;
    readonly repair: string;
}

/** Undefined and empty env values are equivalent: both count as missing. */
export type ContainerEnv = Readonly<Record<string, string | undefined>>;

const present = (env: ContainerEnv, name: string): boolean => (env[name] ?? "").trim() !== "";

export const CONTAINER_REQUIREMENTS: readonly ContainerRequirement[] = [
    // A pre-migration container has the public name but nothing to serve it with: 502 at the edge, forever.
    {
        key: "reachability",
        requires: ["SANDBOX_GRANT", "INGRESS_URL"],
        given: ["SANDBOX_PUBLIC_URL"],
        // A Fly microVM's edge replays directly to it, so it holds no grant by design.
        unless: ["SANDBOX_VM"],
        enables: "reaching this sandbox at its public address, from anywhere",
        lost:
            "Its public address answers 502 to everyone, including this browser when it is not on the same machine as the sandbox. " +
            "On that machine the workspace still works, over a direct connection that never leaves it — which is why this can go unnoticed for a long time.",
        repair: "Re-run this sandbox's setup command. It carries a freshly signed grant, and it keeps the workspace, its history and its Docker engine.",
    },
];

export interface ContainerGap {
    readonly key: string;
    readonly missing: readonly string[];
    readonly enables: string;
    readonly lost: string;
    readonly repair: string;
}

/** Empty means every requirement is met or not applicable; non-empty always means a setup rerun is needed. */
export const containerDrift = (env: ContainerEnv): readonly ContainerGap[] =>
    CONTAINER_REQUIREMENTS.filter(
        (requirement) => requirement.given.every((name) => present(env, name)) && !(requirement.unless ?? []).some((name) => present(env, name)),
    )
        .map((requirement) => ({
            key: requirement.key,
            missing: requirement.requires.filter((name) => !present(env, name)),
            enables: requirement.enables,
            lost: requirement.lost,
            repair: requirement.repair,
        }))
        .filter((gap) => gap.missing.length > 0);
