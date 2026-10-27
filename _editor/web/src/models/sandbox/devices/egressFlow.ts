import { DEVICE_FEATURE_EGRESS, type DeviceFacts, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import {
    canonicalEgressOwnerKeysJson,
    canonicalEgressPolicy,
    EGRESS_NO_REVISION,
    type EgressAllow,
    EgressAllowSchema,
    type EgressBlocked,
    type EgressChangeDocument,
    egressChangeDocumentText,
    egressOnlyTightens,
    type EgressOwnerKeys,
    type EgressPolicy,
    EgressPortSchema,
    type EgressStatus,
    icEgressSetArgs,
    OPEN_EGRESS,
} from "@intentic/sandbox-contract/schemas/egress";
import { t } from "@intentic/ui/i18n";

// WHAT THE NETWORK FENCE SECTION SENDS, AND WHAT IT SIGNS. A sandbox's egress policy is set whole (`set-egress`), and
// `ic` on the machine is the only one that writes it. A change that only tightens goes as it is; anything else carries
// the owner's passkey over the exact change, because the daemon relaying it sits inside the fence and must not be able
// to loosen it by itself: the machine agent checks the signature against the owner keys it pinned. The document signed
// is the contract's (`egressChangeDocumentText`), its challenge the sha256 of that text's bytes.

/** Whether this machine's agent and ic can fence a sandbox at all. */
export const canFence = (facts: Pick<DeviceFacts, "features"> | undefined): boolean => deviceSupports(facts, DEVICE_FEATURE_EGRESS);

/** The policy ic holds, as a change is written against: none held reads as open. */
export const heldPolicy = (status: EgressStatus | undefined): EgressPolicy => status?.policy ?? OPEN_EGRESS;

/** The revision a signed change names back, so the machine carries it out once and never after another change. */
export const heldRevision = (status: EgressStatus | undefined): string => status?.revision ?? EGRESS_NO_REVISION;

/** Whether going from `held` to `next` needs the owner's passkey. */
export const loosens = (held: EgressPolicy, next: EgressPolicy): boolean => !egressOnlyTightens(held, next);

/** Whether two policies fence the same way, labels and order aside. */
export const samePolicy = (left: EgressPolicy, right: EgressPolicy): boolean =>
    JSON.stringify(canonicalEgressPolicy(left)) === JSON.stringify(canonicalEgressPolicy(right));

// What an exception opens, without its labels, so an Allow offered for a way already open is not offered twice.
const reach = (entry: EgressAllow): string => JSON.stringify([entry.to.toLowerCase(), entry.ports ?? null, entry.protocol ?? null]);

/** Whether the policy already holds a way through like this one. */
export const allows = (policy: EgressPolicy, entry: EgressAllow): boolean => policy.allow.some((held) => reach(held) === reach(entry));

/** The policy with one more exception, unless it already holds the same way through. */
export const withException = (policy: EgressPolicy, entry: EgressAllow): EgressPolicy =>
    allows(policy, entry) ? policy : { ...policy, allow: [entry, ...policy.allow] };

/** The policy without the exception at `index`. */
export const withoutException = (policy: EgressPolicy, index: number): EgressPolicy => ({ ...policy, allow: policy.allow.filter((_, at) => at !== index) });

/** A refused destination as the exception that would let it through, named as the owner's. */
export const blockedException = (blocked: EgressBlocked): EgressAllow => {
    const entry: EgressAllow = { to: blocked.to, from: `owner` };
    if (blocked.port !== undefined) {
        entry.ports = [blocked.port];
    }
    if (blocked.protocol !== `other`) {
        entry.protocol = blocked.protocol;
    }
    return entry;
};

/** What the exception form holds, as typed. Blank ports is every port; `both` is TCP and UDP. */
export interface ExceptionForm {
    readonly to: string;
    readonly ports: string;
    readonly protocol: `both` | `tcp` | `udp`;
    readonly note: string;
}

export const EMPTY_EXCEPTION: ExceptionForm = { to: ``, ports: ``, protocol: `both`, note: `` };

/** The form as the exception it means, or the sentence saying what is wrong with it. */
export const exceptionOf = (form: ExceptionForm): { readonly entry: EgressAllow } | { readonly problem: string } => {
    const words = form.ports
        .split(/[\s,]+/u)
        .map((word) => word.trim())
        .filter((word) => word !== ``);
    const ports = words.map((word) => (/^\d+$/u.test(word) ? Number(word) : word));
    const badPort = ports.find((port) => !EgressPortSchema.safeParse(port).success);
    if (badPort !== undefined) {
        return { problem: t(`sandbox.networkFence.badPort`, { port: String(badPort) }) };
    }
    const note = form.note.trim();
    const parsed = EgressAllowSchema.safeParse({
        to: form.to.trim(),
        from: `owner`,
        ...(ports.length > 0 && { ports }),
        ...(form.protocol !== `both` && { protocol: form.protocol }),
        ...(note !== `` && { note }),
    });
    return parsed.success ? { entry: parsed.data } : { problem: parsed.error.issues[0]?.message ?? t(`sandbox.networkFence.badDestination`) };
};

/** One exception in words: its ports and protocol, then its note. */
export const exceptionWords = (entry: EgressAllow): string => {
    const ports = entry.ports === undefined ? t(`sandbox.networkFence.everyPort`) : t(`sandbox.networkFence.ports`, { ports: entry.ports.join(`, `) });
    const protocol = entry.protocol === undefined ? `TCP + UDP` : entry.protocol.toUpperCase();
    return [ports, protocol, entry.note].filter((part) => part !== undefined && part !== ``).join(` · `);
};

/** The fence in one line, and the colour its state reads in. */
export interface FenceLine {
    readonly text: string;
    readonly tone: `default` | `success` | `warning` | `danger`;
}

/** The one-line account of the fence on a sandbox's card and the Overview: what is held, and how it stands. */
export const fenceLine = (status: EgressStatus | undefined): FenceLine => {
    const policy = heldPolicy(status);
    if (policy.profile === `open` || status === undefined) {
        return { text: t(`sandbox.networkFence.lineOff`), tone: `default` };
    }
    const exceptions = policy.allow.length === 0 ? `` : ` · ${t(`sandbox.networkFence.exceptionCount`, { count: policy.allow.length }, policy.allow.length)}`;
    const state = status.state === `enforced` && status.advisory === true ? `advisory` : status.state;
    const tone = state === `enforced` ? `success` : state === `failed` ? `danger` : state === `off` ? `default` : `warning`;
    return { text: `${t(`sandbox.networkFence.lineInternetOnly`)} · ${t(`sandbox.networkFence.state.${state}`)}${exceptions}`, tone };
};

// One argument as a POSIX shell reads it back: bare when nothing in it is special, else single-quoted.
const shellWord = (word: string): string => (/^[\w./:=@-]+$/u.test(word) ? word : `'${word.replaceAll(`'`, `'\\''`)}'`);

/** The command that sets the same policy on the machine itself, where no passkey is asked for. */
export const icEgressCommand = (slug: string, policy: EgressPolicy): string => [`ic`, ...icEgressSetArgs(slug, policy)].map(shellWord).join(` `);

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, `0`)).join(``);

const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
    btoa(String.fromCodePoint(...new Uint8Array(bytes)))
        .replaceAll(`+`, `-`)
        .replaceAll(`/`, `_`)
        .replace(/=+$/u, ``);

const sha256 = (text: string): Promise<ArrayBuffer> => crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(text));

/** How long a signed change is good for: under the machine's five-minute ceiling, with room for a clock a little ahead. */
export const PROOF_LIFETIME_MS = 4 * 60_000;

/** Where the change is carried out: the machine, the side of it the agent enrolled as, and the sandbox. */
export interface ChangeTarget {
    readonly machineId: string;
    readonly environment: string;
    readonly slug: string;
}

/** The document a loosening is signed over, its exact text, and the WebAuthn challenge for it (base64url). */
export const changeToSign = async (
    target: ChangeTarget,
    basedOn: string,
    policy: EgressPolicy,
    ownerKeys: EgressOwnerKeys,
    { now = Date.now(), nonce = base64url(crypto.getRandomValues(new Uint8Array(18))) }: { now?: number; nonce?: string } = {},
): Promise<{ readonly document: EgressChangeDocument; readonly text: string; readonly challenge: string }> => {
    const document: EgressChangeDocument = {
        v: 1,
        purpose: `intentic-egress-change`,
        machineId: target.machineId,
        environment: target.environment,
        slug: target.slug,
        basedOn,
        policy,
        keys: hex(await sha256(canonicalEgressOwnerKeysJson(ownerKeys))),
        expiresAt: now + PROOF_LIFETIME_MS,
        nonce,
    };
    const text = egressChangeDocumentText(document);
    return { document, text, challenge: base64url(await sha256(text)) };
};
