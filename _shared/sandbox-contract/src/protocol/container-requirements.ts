/* WHAT THIS CONTAINER WAS BUILT TO CARRY, AGAINST WHAT IT ACTUALLY CARRIES — the check for a failure this repo
 * has now paid for twice, in the same shape both times.
 *
 * A sandbox's env is written ONCE, by the setup run that created it, and every later recreate REPLAYS it off the
 * container it replaces (@intentic/sandbox-run's REPLAY_ENV). That replay is what makes an update safe: a
 * container comes back on the same public names, the same pairings, the same ceilings, with nobody re-typing
 * anything. It also means a container can only ever carry an absence FORWARD. When a release changes what a
 * container must hold — reachability moving from a zrok trio to a signed grant is the worked example — every box
 * created before it keeps running, keeps announcing, keeps passing health, and quietly cannot do the one thing
 * the new env was for. No restart fixes it. No rebuild fixes it. The values have to arrive from outside, in a
 * setup run, and until somebody works out that this is what happened, the sandbox looks merely broken.
 *
 * THE SIGNATURE OF THAT STATE, and the reason this can be checked generically at all: the container ends up
 * carrying the EVIDENCE of a capability without the MEANS to perform it. It has a public address and nothing to
 * dial an edge with. That inconsistency is internal to the env, so the box can find it in itself, at boot,
 * without asking the platform anything and without a version number to compare against — which matters, because
 * the two things a drifted container cannot be trusted to have are a working tunnel and a recent image.
 *
 * So a requirement is a conditional: GIVEN this evidence, these keys must be present. A release that adds one
 * adds a row here, and every container predating it starts naming its own gap the next time it boots — in the
 * boot report, in `ic sandbox doctor`, and on the sandbox's own Devices view. That is the whole point of the
 * table: the NEXT migration of this kind announces itself instead of waiting to be noticed.
 *
 * Deliberately small. A row belongs here only when all three are true, and inventing rows that fail the last one
 * is how a diagnostic becomes noise nobody reads:
 *   • the keys ride in from a setup run and cannot be re-derived inside the box,
 *   • their absence is SETTLED — no amount of waiting or restarting changes it,
 *   • some other env proves the capability was meant to be there, so "never configured" cannot be mistaken for
 *     "configured and then lost".
 *
 * Env-only and dependency-free on purpose: the daemon evaluates it at boot, `ic sandbox doctor` evaluates it
 * from outside over `docker inspect`, and neither should need the other's runtime to do it. */

/* One thing a container must carry, and the evidence that says it was supposed to.
 *
 * `enables` and `lost` are rendered VERBATIM to the person who has to fix it (the boot report carries them to
 * the browser the way a setup failure's `problem` is carried), so they are written as sentences about the
 * product rather than about the env: nobody reading a Devices view knows what a grant is, and the sentence that
 * explains their sandbox has to work without them learning. */
export interface ContainerRequirement {
    // Stable identity for this gap, so a UI can key, dedupe and link on it without matching prose.
    readonly key: string;
    // The env names that must all be present and non-empty. Named here and nowhere else in this file's readers.
    readonly requires: readonly string[];
    // The env that proves the capability was intended. Absent evidence means "this sandbox never had this",
    // which is a configuration this product supports, not a fault to report.
    readonly given: readonly string[];
    /* Env that proves the capability arrives some OTHER way, so these keys are not this container's to hold.
     * The row is silent when any of it is present.
     *
     * Not a nicety: the same evidence can be satisfied by more than one mechanism, and a check that cannot say
     * so reports the fleet's healthiest boxes as broken. A hosted Fly machine carries a public address it serves
     * perfectly well, by being replayed to rather than by dialling out, and a reachability warning on it would
     * be wrong on every hosted sandbox in existence — the loudest possible way to teach people to ignore this. */
    readonly unless?: readonly string[];
    // What the keys are for, in the user's words.
    readonly enables: string;
    // What does not work while they are missing — the sentence that has to make somebody act.
    readonly lost: string;
    // The one move that restores it. Every row's answer is a setup re-run today; it is spelled per row anyway,
    // because the moment one row's answer differs, a single shared sentence becomes a lie for that row.
    readonly repair: string;
}

/* A container's env, as either side can produce it: `process.env` in the daemon, `docker inspect` parsed into
 * pairs in the CLI. Undefined and empty are the same thing here — a replayed-but-empty var is exactly what a
 * dropped value looks like coming through `-e NAME=`. */
export type ContainerEnv = Readonly<Record<string, string | undefined>>;

const present = (env: ContainerEnv, name: string): boolean => (env[name] ?? "").trim() !== "";

export const CONTAINER_REQUIREMENTS: readonly ContainerRequirement[] = [
    /* THE ROW THIS TABLE WAS WRITTEN FOR. A container created before the reachability migration carries the
     * public name the platform gave it and nothing to serve it with, so its address answers 502 from the edge
     * forever. The daemon says as much at boot (listeners/ingress-tunnel.ts's `reachPosture` reaches the same
     * verdict from the same two keys); this states it as a REQUIREMENT so that the same fact is available to
     * every reader, including the ones outside the container. */
    {
        key: "reachability",
        requires: ["SANDBOX_GRANT", "INGRESS_URL"],
        given: ["SANDBOX_PUBLIC_URL"],
        // A Fly microVM IS the machine, and the platform's edge replays to it rather than being dialled, so it
        // holds no grant by design (main.ts's posture reaches the same conclusion from the same flag).
        unless: ["SANDBOX_VM"],
        enables: "reaching this sandbox at its public address, from anywhere",
        lost:
            "Its public address answers 502 to everyone, including this browser when it is not on the same machine as the sandbox. " +
            "On that machine the workspace still works, over a direct connection that never leaves it — which is why this can go unnoticed for a long time.",
        repair: "Re-run this sandbox's setup command. It carries a freshly signed grant, and it keeps the workspace, its history and its Docker engine.",
    },
];

/* One gap, ready to render: the requirement, plus WHICH of its keys are actually missing. Both halves are
 * needed — the prose is what a person acts on, and the key list is what makes a bug report or a
 * `docker inspect` check unambiguous. */
export interface ContainerGap {
    readonly key: string;
    readonly missing: readonly string[];
    readonly enables: string;
    readonly lost: string;
    readonly repair: string;
}

/* Every requirement this container was meant to meet and does not.
 *
 * Empty is the overwhelmingly common answer and the only one worth optimising for: a container created by a
 * current setup run meets every row, and a sandbox that never had a capability offers no evidence for it, so it
 * is not asked about. A non-empty result always means the same thing — this box was set up before something it
 * now needs, and only a setup run can hand it over. */
export const containerDrift = (env: ContainerEnv): readonly ContainerGap[] =>
    CONTAINER_REQUIREMENTS.filter(
        (requirement) =>
            requirement.given.every((name) => present(env, name)) && !(requirement.unless ?? []).some((name) => present(env, name)),
    )
        .map((requirement) => ({
            key: requirement.key,
            missing: requirement.requires.filter((name) => !present(env, name)),
            enables: requirement.enables,
            lost: requirement.lost,
            repair: requirement.repair,
        }))
        .filter((gap) => gap.missing.length > 0);
