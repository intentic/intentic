import type { Log } from "@intentic/local-agent";
import { SANDBOX_CONTAINER_PREFIX } from "@intentic/sandbox-run";
import { type ContainerAway, type GoneWitness, moveSandboxToSsh, type Pairing, readState, setContainerAway, setIcSlug, setSandboxGone,pairingSlugs } from "./config.js";
import { containerState } from "./endpoint.js";
import { type ContainerState, dockerStep, keptHere, type LocalVerdict, localVerdict, retiresAt } from "./gone.js";
import { type LocalSandboxes, readLocalSandboxes } from "./local-sandboxes.js";

// WHAT THE WATCHER DOES ABOUT A SANDBOX'S FATE (2026-10-05), the side-effecting half of gone.ts's rules: marking a
// sandbox gone, clearing the mark when it answers again, asking this machine's ic whether a sandbox kept here still
// exists, and following a docker pairing whose container went away. mirror.ts calls these at their cadences; each acts
// on every pairing of one sandbox together, since what it says is the sandbox's. Each only keeps its fact: the file
// sync a mark or an away container holds still is held and let go by holds.ts, off that fact.

/** What these actions need from the watcher that runs them. */
export interface FateSeams {
    // Takes the sandbox's forwarded ports off localhost (mirror.ts retirePairingMirror).
    readonly releaseForwards: (sandboxId: string) => Promise<unknown>;
    readonly say: Log;
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

// Whether a pairing of the sandbox still carries a "gone" verdict.
export const goneLingers = (pairings: readonly Pairing[], sandboxId: string): boolean =>
    pairings.some((pairing) => pairing.sandboxId === sandboxId && pairing.goneSince !== undefined);

// The sandbox's pairings as they are on disk now, not as a pass read them: two witnesses in one pass (the poll and the
// report) must find the first one's mark rather than mark it twice.
const pairingsOf = async (sandboxId: string): Promise<Pairing[]> => (await readState()).pairings.filter((pairing) => pairing.sandboxId === sandboxId);

// A WITNESS SAID THIS SANDBOX IS GONE. The first time: the mark goes on every pairing of it (which holds their file sync
// still), its ports come off localhost, and one line says what happened and when the pairing is retired. A recheck that
// still hears it only moves `goneCheckedAt`, quietly.
export const sandboxSaidGone = async (seams: FateSeams, sandboxId: string, by: GoneWitness, now: number = Date.now()): Promise<void> => {
    const pairings = await pairingsOf(sandboxId);
    const first = pairings[0];
    if (first === undefined) {
        return;
    }
    const marked = pairings.find((pairing) => pairing.goneSince !== undefined);
    if (marked?.goneSince !== undefined) {
        await setSandboxGone(first.sandboxId, { since: marked.goneSince, checkedAt: now, by: marked.goneBy ?? by });
        return;
    }
    await setSandboxGone(first.sandboxId, { since: now, checkedAt: now, by });
    await seams.releaseForwards(first.sandboxId);
    const folders = pairings.flatMap((pairing) => (pairing.localDir === undefined ? [] : [pairing.localDir]));
    seams.say(
        `${first.sandboxId}: ${by === "edge" ? "the platform says this sandbox no longer exists" : "this machine's ic no longer holds this sandbox, in its listing or in its trash"}. Its file sync holds still, its ports are off localhost, and stopped dialling and reporting to it; it is asked again every hour. Unless it answers, its pairing is retired on ${utcDay(retiresAt(now))}${folders.length === 0 ? "" : `, keeping ${folders.join(", ")} and ${folders.length === 1 ? "its" : "their"} restore points`}.`,
    );
};

// THE SANDBOX ANSWERED, so whatever said it was gone was wrong or is over (restored from the trash, set up again under
// the same address): the mark comes off every pairing of it, and with it the hold on their file sync.
export const sandboxAnswered = async (seams: FateSeams, sandboxId: string): Promise<void> => {
    const pairings = await pairingsOf(sandboxId);
    if (!goneLingers(pairings, sandboxId)) {
        return;
    }
    await setSandboxGone(sandboxId, undefined);
    seams.say(`${sandboxId}: answers again, so it is not gone after all; its file sync carries on and its ports come back with this pass.`);
};

// The slugs this machine's ic may list a pairing's sandbox under: the two its URL carries (config.ts `pairingSlugs`), the one ic
// listed it under before, and the one its container's name carries.
export const localSlugsOf = (pairing: Pick<Pairing, "sandboxUrl" | "icSlug" | "container">): string[] => [
    ...new Set([
        ...pairingSlugs(pairing.sandboxUrl),
        ...(pairing.icSlug === undefined ? [] : [pairing.icSlug]),
        ...(pairing.container?.startsWith(SANDBOX_CONTAINER_PREFIX) === true ? [pairing.container.slice(SANDBOX_CONTAINER_PREFIX.length)] : []),
    ]),
];

// The pairings of each sandbox, in the order the state lists them.
const bySandbox = (pairings: readonly Pairing[]): Map<string, Pairing[]> => {
    const grouped = new Map<string, Pairing[]>();
    for (const pairing of pairings) {
        grouped.set(pairing.sandboxId, [...(grouped.get(pairing.sandboxId) ?? []), pairing]);
    }
    return grouped;
};

// ASKING THIS MACHINE'S ic about the sandboxes that may be kept here: one it reaches through Docker, one ic listed
// before, or one whose daemon answered on this machine's loopback this pass (`local`). Only those: for any other, ic's
// silence says nothing. A sandbox ic lists is recorded as kept here (`icSlug`), which is what lets its later absence
// count; one kept here that ic's listing and trash both lack is gone, unless it still answers at its address
// (`answering`, its own poll): then it lives on another computer now, and its answer is the better witness (2026-10-06:
// marked gone on ic's word, it was unmarked by that answer each hour and marked again, for ever). Nothing when no
// pairing qualifies, so a machine syncing only hosted sandboxes never runs ic for this.
export const checkKeptHere = async (
    seams: FateSeams,
    pairings: readonly Pairing[],
    local: ReadonlySet<string>,
    read: () => Promise<LocalSandboxes> = readLocalSandboxes,
    answering: (sandboxId: string) => boolean = () => false,
): Promise<void> => {
    const asked = [...bySandbox(pairings)].filter(([sandboxId, held]) => local.has(sandboxId) || held.some(keptHere));
    if (asked.length === 0) {
        return;
    }
    const answer = await read();
    if (answer.listed === undefined) {
        return;
    }
    for (const [sandboxId, held] of asked) {
        const slugs = [...new Set(held.flatMap(localSlugsOf))];
        const verdict = localVerdict(slugs, answer.listed, answer.trashed);
        if (verdict === "here") {
            const slug = slugs.find((candidate) => answer.listed?.includes(candidate));
            if (slug !== undefined && held.some((pairing) => pairing.icSlug !== slug)) {
                // state is a single file; serial keeps the writes ordered
                await setIcSlug(sandboxId, slug);
            }
            // Back in ic's listing (restored from its trash): what ic itself said is withdrawn by ic. The edge's verdict
            // is the platform's, and only the sandbox answering withdraws that.
            if (held.some((pairing) => pairing.goneBy === "local")) {
                // ditto
                await sandboxAnswered(seams, sandboxId);
            }
        } else if (verdict === "gone" && held.some(keptHere) && !answering(sandboxId)) {
            // ditto
            await sandboxSaidGone(seams, sandboxId, "local");
        }
    }
};

// FOLLOWING A DOCKER PAIRING'S CONTAINER (gone.ts `dockerStep`), for each sandbox reached through Docker. `answering` is
// whether the sandbox's own poll has been answering, which is what says a sandbox whose container left this machine
// still lives somewhere. ic is asked only once a container is actually missing, and once per call.
export const checkContainers = async (
    seams: FateSeams,
    pairings: readonly Pairing[],
    answering: (sandboxId: string) => boolean,
    {
        state = containerState,
        read = readLocalSandboxes,
    }: { readonly state?: typeof containerState; readonly read?: () => Promise<LocalSandboxes> } = {},
): Promise<void> => {
    // ic is asked once per call, and only once some container is actually missing.
    let local: Promise<LocalSandboxes> | undefined;
    const askIc = async (): Promise<LocalSandboxes> => await (local ??= read());
    for (const [sandboxId, held] of bySandbox(pairings)) {
        const docker = held.find((pairing) => pairing.transport === "docker" && pairing.container !== undefined && pairing.goneSince === undefined);
        if (docker?.container !== undefined) {
            // one engine call per sandbox reached through Docker, a handful at most
            await followContainer(seams, { sandboxId, held, container: docker.container, docker }, await state(docker.container, docker.sandboxUrl), {
                answering: answering(sandboxId),
                askIc,
            });
        }
    }
};

/** One sandbox reached through Docker, as `checkContainers` follows it. */
interface DockerSandbox {
    readonly sandboxId: string;
    readonly held: readonly Pairing[];
    readonly container: string;
    readonly docker: Pairing;
}

// One sandbox's step (gone.ts `dockerStep`), carried out.
const followContainer = async (
    seams: FateSeams,
    sandbox: DockerSandbox,
    container: ContainerState,
    { answering, askIc }: { readonly answering: boolean; readonly askIc: () => Promise<LocalSandboxes> },
): Promise<void> => {
    const { sandboxId, held, docker } = sandbox;
    if (container === "serves") {
        if (held.some((pairing) => pairing.containerAway !== undefined)) {
            await setContainerAway(sandboxId, undefined);
            seams.say(`${sandboxId}: ${sandbox.container} runs as this sandbox again; its file sync carries on.`);
        }
        return;
    }
    const local = container === "missing" ? await askIc() : undefined;
    const verdict: LocalVerdict =
        local === undefined ? "unknown" : localVerdict([...new Set(held.flatMap(localSlugsOf))], local.listed, local.trashed);
    const step = dockerStep({ container, local: verdict, enrolled: docker.syncToken !== undefined, answering });
    if (step === "gone") {
        await sandboxSaidGone(seams, sandboxId, "local");
    } else if (step === "ssh") {
        await moveSandboxToSsh(sandboxId);
        seams.say(
            `${sandboxId}: ${sandbox.container} is no longer on this machine's Docker engine, but the sandbox still answers at ${docker.sandboxUrl}: its file sync moves to ssh, through the sandbox's own address.`,
        );
    } else if (step === "pause-missing" || step === "pause-trashed") {
        await containerAway(seams, sandbox, step === "pause-trashed" ? "trashed" : "missing");
    }
};

// The sandbox's pairings held still for its container, said once when that is news.
const containerAway = async (seams: FateSeams, sandbox: DockerSandbox, away: ContainerAway): Promise<void> => {
    if (sandbox.held.every((pairing) => pairing.containerAway === away)) {
        return;
    }
    await setContainerAway(sandbox.sandboxId, away);
    seams.say(
        away === "trashed"
            ? `${sandbox.sandboxId}: was removed from this machine and sits in ic's trash, so its file sync holds still. \`ic sandbox restore\` brings it back, and its file sync with it.`
            : `${sandbox.sandboxId}: ${sandbox.container} is no longer on this machine's Docker engine and the sandbox is not answering, so its file sync holds still until it is back.`,
    );
};
