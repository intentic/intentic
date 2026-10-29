import type { InviteDelivery, InviteRecord } from "@intentic/api-contract";
import type { ManageRight, MemberGrant } from "@intentic/sandbox-contract/schemas/members";
import { clipboardOf, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, ref, type Ref, watch } from "vue";
import { grantMember, revokeMember } from "../../../../client/sandbox/useMembers";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { apiClient } from "../../../../lib/useApi";
import { type RunOptions, useOperation } from "../../../../workbench/operations/operations";
import { type AccessDraft, draftGrant, draftProblem } from "../accessGrant";
import { usePersonaReach } from "../usePersonaReach";

// THE ROSTER WRITES ARE THE SANDBOX'S, NOT THE PEOPLE TAB'S. An invite, a resend, a re-grade and a revoke are each two
// writes (the daemon's enforced list, then the platform's record), one at a time, and they live in the operations ledger:
// the tab opened again mid-write holds its buttons, and the accept link of an invite mail could not deliver is kept
// until whoever manages people moves on to the next write, since it can only be read there. The platform's record
// carries the tier and the rights, so a re-grade that moves either brings it along.

// What a write answers: the platform's roster, and for an invite or a resend, how it went out. The daemon's roster is
// not among them: it lands in the members cache entry as the daemon answers it.
interface RosterWrite {
    readonly members?: InviteRecord[];
    readonly delivery?: { readonly link: string; readonly delivery: InviteDelivery; readonly reason?: string };
}
// A refusal, and whether the roster on screen may no longer be true: the daemon granted, then the platform refused.
interface RosterRefusal {
    readonly notice: NoticeModel;
    readonly reload: boolean;
}
// The daemon's refusal, the first of the two writes: nothing changed, and it carries its own sentence, with what the
// daemon said as its cause.
class DaemonRefused extends Error {
    constructor(
        readonly sentence: string,
        options: ErrorOptions,
    ) {
        super(sentence, options);
    }
}
// What a roster write's refusal becomes, typed by the ledger's own option so the thrown value stays the ledger's to name.
type RosterFailed = Extract<RunOptions<RosterWrite, RosterRefusal>[`failed`], (...args: never[]) => RosterRefusal>;
const refusedAs =
    (recording: string): RosterFailed =>
    (error) =>
        error instanceof DaemonRefused
            ? { notice: noticeFrom(error.cause, error.sentence), reload: false }
            : { notice: noticeFrom(error, recording), reload: true };

// Not an error: already invited, just unreachable by mail; `sent` needs no entry here. Built when read, so the note
// follows a language switch.
const deliveryNote = (delivery: Exclude<InviteDelivery, "sent">): string =>
    ({
        unconfigured: t(`sandbox.sandboxAccess.deliveryUnconfigured`),
        "local-link": t(`sandbox.sandboxAccess.deliveryLocalLink`),
        refused: t(`sandbox.sandboxAccess.deliveryRefused`),
    })[delivery];

// Whether the platform's record already holds these rights; absent is none on either side.
const sameRights = (recorded: readonly ManageRight[] | undefined, granted: readonly ManageRight[] | undefined): boolean => {
    const held = new Set(recorded ?? []);
    return held.size === (granted ?? []).length && (granted ?? []).every((right) => held.has(right));
};

// Daemon push first, enforced; sandboxRaw throws on non-2xx, so an unenforced grant is never recorded as sent. Its
// answer is the daemon's whole roster, which lands in the members cache entry (useMembers) whole.
const grantOnDaemon = async (grant: MemberGrant, refused: string): Promise<void> => {
    try {
        await grantMember(grant);
    } catch (err) {
        throw new DaemonRefused(refused, { cause: err });
    }
};

export interface RosterWritesDeps {
    // The platform's invite records, which a write's answer replaces.
    readonly members: Ref<InviteRecord[]>;
    // Whether the daemon's roster cannot be trusted right now, and the notice that says so.
    readonly fencesUnknown: ComputedRef<boolean>;
    readonly grantsUnread: ComputedRef<NoticeModel | undefined>;
    // A person's access was taken away: their panel closes.
    readonly revoked: (email: string) => void;
}

type Writes = ReturnType<typeof useOperation<RosterWrite, RosterRefusal>>;

// What the tab says of its writes: a refusal, or an invite whose link must be carried by hand.
const rosterNotices = (writes: Writes) => {
    // What the tab decided by itself (a roster it couldn't read, a re-grade it won't send), beside the writes' own words.
    const localNotice = ref<NoticeModel>();
    // The delivery an invite or resend reported, when mail did not carry it.
    const undelivered = computed(() => {
        const delivered = writes.operation.value?.state === `done` ? writes.value.value?.delivery : undefined;
        return delivered === undefined || delivered.delivery === `sent` ? undefined : delivered;
    });
    const deliveryNotice = computed((): NoticeModel | undefined => {
        const result = undelivered.value;
        return result === undefined || result.delivery === `sent`
            ? undefined
            : {
                  tone: `warning`,
                  title: deliveryNote(result.delivery),
                  detail: result.reason,
                  action: {
                      label: t(`ui.action.copyLink`),
                      // Uses the clicked element's own window; best-effort, so a refusal here isn't the invite failing.
                      // allow(silent-catch): the link is printed whole beside the press, so a refused clipboard leaves it there to copy by hand.
                      run: () => void Promise.resolve(clipboardOf(document.activeElement)?.writeText(result.link)).catch(() => undefined),
                  },
              };
    });
    // The one thing the tab has to say right now: a failure, or an invite whose link must be carried by hand.
    const notice = computed(() => localNotice.value ?? writes.failure.value?.notice ?? deliveryNotice.value);
    return {
        localNotice,
        notice,
        // What the open panel says: a write it made that was refused, or a roster it cannot trust. A link to carry is the page's.
        panelNotice: computed(() => localNotice.value ?? writes.failure.value?.notice),
        // Accept link to carry when mail didn't; beside `notice`, not inside it, since a link is markup.
        handover: computed(() => (notice.value !== undefined && notice.value === deliveryNotice.value ? undelivered.value?.link : undefined)),
        // Clear the notice and its invite link together before the next write.
        clearNotice: (): void => {
            localNotice.value = undefined;
            writes.dismiss();
        },
    };
};

// The platform's records, read once and then kept by each write's own answer.
const rosterList = (writes: Writes, members: Ref<InviteRecord[]>, localNotice: Ref<NoticeModel | undefined>, sandboxId: () => string | undefined) => {
    // True until the first read lands; every later refresh rides a write's own response, never blank again.
    const listing = ref(true);
    const load = async (): Promise<void> => {
        const id = sandboxId();
        if (id === undefined) {
            listing.value = false;
            return;
        }
        // Only this tab's own words: an invite's link kept in the ledger outlives the tab being opened again.
        localNotice.value = undefined;
        // A first read, or one asked for once the reader turns out to manage people, draws the wait rather than nobody.
        if (members.value.length === 0) {
            listing.value = true;
        }
        try {
            // The platform's records only: the daemon's roster, the one that says which cards a guest holds, is its own
            // cache entry. One that isn't answering leaves the list up and says the fences are unknown (`grantsUnread`),
            // rather than drawing every row as unfenced.
            members.value = (await apiClient.invite.list({ sandboxId: id })).members;
        } catch (err) {
            localNotice.value = noticeFrom(err, t(`sandbox.sandboxAccess.couldntLoadAccessList`));
        } finally {
            listing.value = false;
        }
    };
    // A write's answer is the platform's roster as it now stands, put on screen by whichever mount of the tab is up when
    // it lands; a write refused after the daemon granted leaves the screen unsure, so the platform's roster is read again
    // (the daemon's is already the cache's).
    watch(
        () => writes.operation.value,
        (now, before) => {
            if (before?.state !== `running` || now === undefined || now.order !== before.order || now.state === `running`) {
                return;
            }
            if (now.state === `failed`) {
                if (now.failure?.reload === true) {
                    void load();
                }
                return;
            }
            if (now.value?.members !== undefined) {
                members.value = now.value.members;
            }
        },
    );
    return { listing, load };
};

// What every write reads: the ledger, the sandbox it writes to, and how the tab stands.
interface WriteContext extends RosterWritesDeps {
    readonly writes: Writes;
    readonly sandboxId: () => string | undefined;
    readonly namesOf: ReturnType<typeof usePersonaReach>[`namesOf`];
    readonly localNotice: Ref<NoticeModel | undefined>;
    readonly clearNotice: () => void;
}

// Sending someone in: the grant to the daemon, then the platform's record and its mail.
const inviteWrites = ({ writes, sandboxId, namesOf, clearNotice }: WriteContext) => ({
    invite: async (value: string, draft: AccessDraft): Promise<boolean> => {
        const id = sandboxId();
        if (id === undefined || writes.busy.value || draftProblem(draft, namesOf(draft.see).length) !== undefined) {
            return false;
        }
        clearNotice();
        const grant = draftGrant(value, draft);
        const outcome = await writes.run({
            what: t(`sandbox.sandboxAccess.invitingWhom`, { email: value }),
            failed: refusedAs(t(`sandbox.sandboxAccess.recordingInviteFailed`)),
            // The link mail could not carry is read here or nowhere.
            keep: true,
            task: async () => {
                await grantOnDaemon(grant, t(`sandbox.sandboxAccess.couldntGrantAccess`));
                const result = await apiClient.invite.create({ sandboxId: id, email: value, role: grant.role, manages: grant.manages });
                return { members: result.members, delivery: result };
            },
        });
        return outcome?.state === `done`;
    },
    resend: async (target: string): Promise<boolean> => {
        const id = sandboxId();
        if (id === undefined || writes.busy.value) {
            return false;
        }
        clearNotice();
        const outcome = await writes.run({
            what: t(`sandbox.sandboxAccess.invitingWhom`, { email: target }),
            // Nothing was granted first, so a refusal leaves the roster as it is.
            failed: (error) => ({ notice: noticeFrom(error, t(`sandbox.sandboxAccess.couldntResendInvite`)), reload: false }),
            keep: true,
            task: async () => {
                const result = await apiClient.invite.resend({ sandboxId: id, email: target });
                return { members: result.members, delivery: result };
            },
        });
        // Sent: a link the mail could not carry is said above the tiles, with the panel left open.
        return outcome?.state === `done`;
    },
});

// Changes what a person holds with the same two-write, daemon-first order as an invite: the whole grant to the daemon,
// then the tier and rights to the platform's record when either moved. Applies on the person's next request.
const saveWrite =
    ({ writes, sandboxId, namesOf, clearNotice, members, fencesUnknown, grantsUnread, localNotice }: WriteContext) =>
    async (target: string, draft: AccessDraft): Promise<boolean> => {
        const id = sandboxId();
        if (id === undefined || draftProblem(draft, namesOf(draft.see).length) !== undefined) {
            return false;
        }
        clearNotice();
        if (fencesUnknown.value) {
            localNotice.value = grantsUnread.value;
            return false;
        }
        const grant = draftGrant(target, draft);
        const recorded = members.value.find((member) => member.email === target);
        const outcome = await writes.run({
            what: t(`sandbox.sandboxAccess.changingAccessOf`, { email: target }),
            failed: refusedAs(t(`sandbox.sandboxAccess.recordingRoleFailed`)),
            // Quiet: the panel's own Saved is the answer.
            quiet: true,
            task: async () => {
                // Same split as the invite: only the first of the two writes can be a sandbox that isn't answering.
                await grantOnDaemon(grant, t(`sandbox.sandboxAccess.couldntChangeRole`));
                if (recorded?.role === grant.role && sameRights(recorded.manages, grant.manages)) {
                    return {};
                }
                const result = await apiClient.invite.setRole({ sandboxId: id, email: target, role: grant.role, manages: grant.manages });
                return { members: result.members };
            },
        });
        return outcome?.state === `done`;
    };

// Taking access away: the daemon first, so a sandbox that refuses or is offline leaves nothing standing on record alone.
const revokeWrite =
    ({ writes, sandboxId, clearNotice, revoked }: WriteContext) =>
    async (target: string): Promise<void> => {
        const id = sandboxId();
        if (id === undefined || writes.busy.value) {
            return;
        }
        clearNotice();
        // Quiet: the row going away is the answer.
        const outcome = await writes.run({
            what: t(`sandbox.sandboxAccess.revokingWhom`, { email: target }),
            failed: refusedAs(t(`sandbox.sandboxAccess.clearingRecordFailed`)),
            quiet: true,
            task: async () => {
                try {
                    await revokeMember(target);
                } catch (err) {
                    throw new DaemonRefused(t(`sandbox.sandboxAccess.couldntRevokeAccess`), { cause: err });
                }
                const result = await apiClient.invite.revoke({ sandboxId: id, email: target });
                return { members: result.members };
            },
        });
        if (outcome?.state === `done`) {
            revoked(target);
        }
    };

export function useRosterWrites(deps: RosterWritesDeps) {
    const sandbox = useSandbox();
    const sandboxId = (): string | undefined => sandbox.activeSandboxId.value;
    // Which assistants a fence hands over: derived from where each card works, never picked per person.
    const { namesOf } = usePersonaReach();
    const writes = useOperation<RosterWrite, RosterRefusal>(`access/members/write`);
    const notices = rosterNotices(writes);
    const context: WriteContext = { ...deps, writes, sandboxId, namesOf, localNotice: notices.localNotice, clearNotice: notices.clearNotice };
    const saveAccess = saveWrite(context);

    // The panel saves as it goes, and a write is one at a time: a change made while one is on its way waits behind it
    // rather than being dropped, and only the newest change per person is sent once its turn comes.
    let queue: Promise<unknown> = Promise.resolve();
    const latest = new Map<string, AccessDraft>();
    const savePerson = (target: string, draft: AccessDraft): void => {
        latest.set(target, draft);
        queue = queue.then(async () => {
            const next = latest.get(target);
            if (next === undefined) {
                return;
            }
            latest.delete(target);
            await saveAccess(target, next);
        });
    };

    return {
        busy: writes.busy,
        ...notices,
        ...rosterList(writes, deps.members, notices.localNotice, sandboxId),
        ...inviteWrites(context),
        savePerson,
        revoke: revokeWrite(context),
    };
}
