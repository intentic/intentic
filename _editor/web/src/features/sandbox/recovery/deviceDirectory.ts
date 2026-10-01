import { type SandboxSummary, type User, UserSchema } from "@intentic/api-contract";
import { MemberRoleSchema } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../../../lib/browserStorage";
import { normalizeDaemonUrl } from "../../setup/setupAttach";

// THE SANDBOXES THIS DEVICE REMEMBERS, per account: where each answered when the platform last listed it, so a
// platform that is down, or that answers from a database that forgot them, never leaves its owner with nothing to
// open (README.md). Names, logos and addresses only, never a token: the list itself stays off disk because its rows
// carry connect tokens (queryPersistence.ts), and nothing here needs one, since a daemon checks a Google sign-in
// itself. Kept through the teardown a refused session triggers (authLifecycle.ts), which is exactly when it is needed;
// dropped by an explicit sign-out.

const KEY = `intentic.deviceDirectory`;
// A sandbox no list has shown for this long, and that nothing reconnected, is let go of.
const FORGET_MISSING_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const RememberedSandboxSchema = z.object({
    // The platform row id when last listed: the key its daemon session is stored under (sandboxSession.ts).
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    // Normalized (setupAttach.ts), the key a remembered sandbox is matched by across rows and databases.
    daemonUrl: z.string(),
    role: MemberRoleSchema,
    hosted: z.boolean(),
    lastSeenAt: z.string().nullable(),
    // ISO, when a list first came back without it; absent while it is listed.
    missingSince: z.string().optional(),
    // What the platform answered when asked about it while missing (sandbox.lookup): only `unknown` is offered back.
    standing: z.enum([`unknown`]).optional(),
});
export type RememberedSandbox = z.infer<typeof RememberedSandboxSchema>;

const RememberedAccountSchema = z.object({
    // The last real account object, whole: direct mode signs in as it, so presence, analytics and the cache buster all
    // see the account they saw before the outage (directMode.ts).
    user: UserSchema,
    // The platform database the last list came from (GET /api/identity), when it said.
    identity: z.string().optional(),
    // ISO, when this device first saw the platform answer from another database than the one it remembered; cleared
    // once nothing is missing any more.
    resetSince: z.string().optional(),
    savedAt: z.string(),
    sandboxes: z.array(RememberedSandboxSchema),
});
export type RememberedAccount = z.infer<typeof RememberedAccountSchema>;

const DirectorySchema = z.object({
    version: z.literal(1),
    // The account that last listed, for the outage screen, which has no session to name one.
    last: z.string().optional(),
    accounts: z.record(z.string(), RememberedAccountSchema),
});
type DeviceDirectory = z.infer<typeof DirectorySchema>;

const EMPTY: DeviceDirectory = { version: 1, accounts: {} };

const accountKey = (email: string): string => email.trim().toLowerCase();

// Unreadable, missing or of a shape this build has no word for: an empty directory, never an error.
const read = (): DeviceDirectory => {
    const raw = storedValue(KEY);
    if (raw === undefined) {
        return EMPTY;
    }
    try {
        const parsed = DirectorySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : EMPTY;
    } catch {
        // allow(silent-catch): a value that is not JSON is a directory this device can no longer read, so it starts over.
        return EMPTY;
    }
};

// allow(module-state): the device's memory, mirrored so cards and screens react to every write
const directory = ref<DeviceDirectory>(read());

const write = (next: DeviceDirectory): void => {
    directory.value = next;
    storeValue(KEY, JSON.stringify(next));
};

// The 12-hex id a sandbox's hostname carries (`sandbox-<id>.<zone>`), the one the platform's lookup names; undefined
// for a sandbox behind a domain of its own, whose daemon's /health says it instead.
export const sandboxIdOfUrl = (daemonUrl: string): string | undefined => {
    const label = new URL(daemonUrl).hostname.split(`.`)[0] ?? ``;
    return /^sandbox-([0-9a-f]{12})$/.exec(label)?.[1];
};

const rememberedOf = (row: SandboxSummary & { readonly daemonUrl: string }): RememberedSandbox => ({
    id: row.id,
    name: row.name,
    image: row.image,
    daemonUrl: row.daemonUrl,
    role: row.role,
    hosted: row.hosted !== null,
    lastSeenAt: row.lastSeenAt,
});

// The rows worth remembering, by normalized address: a draft that never got one has nothing to open.
const addressed = (rows: readonly SandboxSummary[]): (SandboxSummary & { readonly daemonUrl: string })[] =>
    rows.flatMap((row) => {
        const daemonUrl = row.daemonUrl === null ? undefined : normalizeDaemonUrl(row.daemonUrl);
        return daemonUrl === undefined ? [] : [{ ...row, daemonUrl }];
    });

// What an account's memory becomes after a list: every listed sandbox as listed, every remembered one the list lacks
// kept and marked missing (a platform that forgot it lists nothing, which is no reason to forget it here), until it
// has been missing a month. A different database than the one remembered starts `resetSince`; nothing missing ends it.
export const mergeListed = (
    held: RememberedAccount | undefined,
    user: User,
    rows: readonly SandboxSummary[],
    identity: string | undefined,
    now: Date,
): RememberedAccount => {
    const listed = addressed(rows).map(rememberedOf);
    const listedUrls = new Set(listed.map((entry) => entry.daemonUrl));
    const missing = (held?.sandboxes ?? [])
        .filter((entry) => !listedUrls.has(entry.daemonUrl))
        .map((entry) => ({ ...entry, missingSince: entry.missingSince ?? now.toISOString() }))
        .filter((entry) => now.getTime() - Date.parse(entry.missingSince) < FORGET_MISSING_AFTER_MS);
    const switched = held?.identity !== undefined && identity !== undefined && held.identity !== identity;
    const resetSince = missing.length === 0 ? undefined : switched ? now.toISOString() : held?.resetSince;
    const account: RememberedAccount = { user, savedAt: now.toISOString(), sandboxes: [...listed, ...missing] };
    const known = identity ?? held?.identity;
    if (known !== undefined) {
        account.identity = known;
    }
    if (resetSince !== undefined) {
        account.resetSince = resetSince;
    }
    return account;
};

// Records a list the platform answered for this account; the account becomes the one the outage screen offers.
export const rememberListed = (user: User, rows: readonly SandboxSummary[], identity: string | undefined, now = new Date()): void => {
    const key = accountKey(user.email);
    const current = directory.value;
    write({ ...current, last: key, accounts: { ...current.accounts, [key]: mergeListed(current.accounts[key], user, rows, identity, now) } });
};

// The memory of one account, or of the one that last listed when none is named.
export const rememberedAccount = (email?: string): RememberedAccount | undefined => {
    const current = directory.value;
    const key = email === undefined ? current.last : accountKey(email);
    return key === undefined ? undefined : current.accounts[key];
};

// The sandboxes an account remembers that its list lacks, owned and shared alike; the recovery screen sorts them.
export const missingSandboxes = (email: string): readonly RememberedSandbox[] =>
    rememberedAccount(email)?.sandboxes.filter((entry) => entry.missingSince !== undefined) ?? [];

// Whether a list that offers nothing to open should send this account to recovery rather than onboarding: it owns a
// sandbox this device remembers and the list lacks. A share that left the list is the owner's to bring back.
export const ownsMissingSandboxes = (email: string): boolean => missingSandboxes(email).some((entry) => entry.role === `owner`);

// Rewrites one remembered sandbox of one account, by address; nothing for an address it does not hold.
const update = (email: string, daemonUrl: string, change: (entry: RememberedSandbox) => RememberedSandbox | undefined): void => {
    const key = accountKey(email);
    const current = directory.value;
    const account = current.accounts[key];
    if (account === undefined) {
        return;
    }
    const sandboxes = account.sandboxes.flatMap((entry) => {
        if (entry.daemonUrl !== daemonUrl) {
            return [entry];
        }
        const changed = change(entry);
        return changed === undefined ? [] : [changed];
    });
    write({ ...current, accounts: { ...current.accounts, [key]: { ...account, sandboxes } } });
};

// The platform said it has no record of a missing sandbox: the one standing recovery offers back.
export const noteUnknown = (email: string, daemonUrl: string): void => update(email, daemonUrl, (entry) => ({ ...entry, standing: `unknown` }));

// A sandbox this account no longer has: deleted, someone else's, or let go of by the reader.
export const forgetSandbox = (email: string, daemonUrl: string): void => update(email, daemonUrl, () => undefined);

// A sandbox deleted from this device, on every account that remembers it (a delete names no account).
export const forgetAddress = (daemonUrl: string): void => {
    const url = normalizeDaemonUrl(daemonUrl);
    for (const key of Object.keys(directory.value.accounts)) {
        if (url !== undefined) {
            forgetSandbox(key, url);
        }
    }
};

// An explicit sign-out: this device stops remembering the account's sandboxes, and offers them nowhere.
export const forgetAccount = (email: string): void => {
    const key = accountKey(email);
    const { [key]: _forgotten, ...accounts } = directory.value.accounts;
    const next: DeviceDirectory = { version: 1, accounts };
    if (directory.value.last !== undefined && directory.value.last !== key) {
        next.last = directory.value.last;
    }
    write(next);
};

// The reactive memory, for the cards and screens that show it.
export const useDeviceDirectory = () => ({ directory });
