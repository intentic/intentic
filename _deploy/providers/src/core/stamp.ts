import type { ProviderContext } from "@intentic/engine";
import { HASH_KEY, OWNER_KEY, STAMP_KEY } from "@intentic/graph";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { containerId } from "./backing-ssh.js";
import type { SshSession } from "./ssh.js";

// The ownership stamp a container carries as Docker labels: its node id (how a read finds it), its kind (how a scan
// lists it), its inputs hash (drift without a provider diff) and the intent that owns it (so a scan of a host two
// intents share only ever claims its own). One place renders it, so every container provider stamps the same set.
export interface ContainerStamp {
    readonly id: string;
    readonly hash: string;
    // Absent when the graph carries no owner (resolved before owners existed); the label is then omitted.
    readonly owner?: string;
}

export const stampOf = (ctx: ProviderContext): ContainerStamp => ({
    id: ctx.id,
    hash: ctx.inputsHash ?? "",
    ...(ctx.owner !== undefined ? { owner: ctx.owner } : {}),
});

// Every label of the stamp as `key=value`; protection is omitted rather than written false.
export const stampLabelPairs = (kind: string, stamp: ContainerStamp, protect = false): string[] => [
    `${STAMP_KEY}=${stamp.id}`,
    `intentic.type=${kind}`,
    `${HASH_KEY}=${stamp.hash}`,
    ...(stamp.owner !== undefined ? [`${OWNER_KEY}=${stamp.owner}`] : []),
    ...(protect ? ["intentic.protect=true"] : []),
];

// The compose `labels:` line of the stamped service.
export const stampLabels = (kind: string, stamp: ContainerStamp, protect = false): string =>
    `    labels: [ ${stampLabelPairs(kind, stamp, protect)
        .map((pair) => `"${pair}"`)
        .join(", ")} ]`;

// The `docker run` flags for the stamp, plus any of the provider's own labels.
export const stampLabelArgs = (kind: string, stamp: ContainerStamp, extra: readonly string[] = []): string =>
    [...stampLabelPairs(kind, stamp), ...extra].map((pair) => `--label ${shellQuote(pair)}`).join(" ");

// The hash and owner stamps of the container stamped intentic.id=<stamp>, in one inspect; "" for a label it lacks (a
// container from before hashes or owners) or when nothing is running.
export const containerStampOf = async (session: SshSession, stamp: string): Promise<{ readonly hash: string; readonly owner: string }> => {
    const id = await containerId(session, stamp);
    if (id === "") {
        return { hash: "", owner: "" };
    }
    const format = `{{index .Config.Labels "${HASH_KEY}"}}|{{index .Config.Labels "${OWNER_KEY}"}}`;
    const result = await session.exec(`docker inspect --format ${shellQuote(format)} ${id}`);
    const [hash = "", owner = ""] = result.stdout.trim().split("|");
    return { hash, owner };
};

// The stamp half of a container read's Observed: the hash when one is stamped, and the owner always (possibly "", which
// the engine adopts). Only for a provider whose update re-stamps, or adoption would never converge.
export const observedStamp = (stamp: { readonly hash: string; readonly owner: string }): { stampHash?: string; stampOwner: string } => ({
    ...(stamp.hash === "" ? {} : { stampHash: stamp.hash }),
    stampOwner: stamp.owner,
});
