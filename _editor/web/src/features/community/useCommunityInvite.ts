import { COMMUNITY_DISCORD_URL } from "@intentic/constants";
import { computed, effectScope, type Ref, ref, watch } from "vue";
import { z } from "zod";
import { track } from "../../app/analytics";
import { deviceKey, storedJson, storeJson } from "../../app/storage/browserStorage";
import { useAccount } from "../../client/auth/useAccount";
import { useRole } from "../../client/sandbox/useRole";
import { pastFirstDays, workLanded } from "../../models/fleet/fleetHistory";
import { registry } from "../../models/fleet/useAgents-registry";
import {
    dotShown,
    finishedAsks,
    type InviteAnswer,
    type InviteFacts,
    type InvitePlace,
    type InviteRecord,
    markAnswered,
    markAsked,
    noteEngagement,
    noteShown,
} from "./communityInvite";

// The community invitation as the editor draws it (the rules are communityInvite.ts): this account's record in this
// browser, the facts of the sandbox open now, and the presses. One instance per window, so the avatar's dot, the
// account menu's note and the finished checklist all read the same answer.

export interface CommunityInvite {
    readonly url: string;
    // The avatar's quiet dot: an ask waits in the account menu, unseen.
    readonly dot: Readonly<Ref<boolean>>;
    // The account menu's (and a phone Menu's) note, on the visit it was first seen on.
    readonly note: Readonly<Ref<boolean>>;
    // The finished checklist's line: until they have answered, from any door.
    readonly onFinished: Readonly<Ref<boolean>>;
    // The ask was put in front of them here; only the first sighting is recorded or told.
    readonly seen: (place: InvitePlace) => void;
    // They answered the ask, or found their own way in through the plain row or the palette.
    readonly answer: (place: InvitePlace, answer: InviteAnswer) => void;
    // The palette's door: opens the invite in a tab of its own, as the row's link does.
    readonly open: (place: InvitePlace) => void;
}

// When this page was opened: a note first seen before it is one already shown on an earlier visit.
const PAGE_OPENED_AT = Date.now();

const RecordSchema = z.object({
    engagedAt: z.number().optional(),
    askedAt: z.number().optional(),
    closed: z.enum([`joined`, `declined`]).optional(),
});

const keyOf = (account: string): string => deviceKey(`intentic.communityInvite.${account}`);

let instance: CommunityInvite | undefined;

const create = (): CommunityInvite => {
    const { user } = useAccount();
    const { canShip } = useRole();

    // A local window's placeholder account has no id, only the address it was signed in with.
    const account = computed(() => {
        const current = user.value;
        return current === null ? undefined : current.id || current.email || undefined;
    });
    const record = ref<InviteRecord>({});
    watch(
        account,
        (id) => {
            record.value = id === undefined ? {} : (storedJson(keyOf(id), RecordSchema) ?? {});
        },
        { immediate: true },
    );
    const write = (next: InviteRecord): void => {
        const id = account.value;
        if (id === undefined || next === record.value) {
            return;
        }
        record.value = next;
        storeJson(keyOf(id), next);
    };

    // Read off the roster the board already holds: the sandbox past its first run (models/fleet/fleetHistory.ts).
    const facts = computed<InviteFacts>(() => ({
        canShip: canShip.value,
        landed: workLanded(registry.value),
        established: pastFirstDays(registry.value, Date.now()),
    }));
    // The first time the account is seen past its first run is the day the menu's ask is counted from.
    watch([facts, account], ([now]) => write(noteEngagement(record.value, now, Date.now())), { immediate: true });

    const seen = (place: InvitePlace): void => {
        if (record.value.askedAt !== undefined || record.value.closed !== undefined) {
            return;
        }
        write(markAsked(record.value, Date.now()));
        track(`community_invite_shown`, { place });
    };
    const answer = (place: InvitePlace, given: InviteAnswer): void => {
        write(markAnswered(record.value, given, Date.now()));
        track(given === `joined` ? `community_invite_opened` : `community_invite_declined`, { place });
    };

    return {
        url: COMMUNITY_DISCORD_URL,
        dot: computed(() => account.value !== undefined && dotShown(record.value, facts.value, Date.now())),
        note: computed(() => account.value !== undefined && noteShown(record.value, facts.value, Date.now(), PAGE_OPENED_AT)),
        onFinished: computed(() => account.value !== undefined && finishedAsks(record.value)),
        seen,
        answer,
        open: (place) => {
            window.open(COMMUNITY_DISCORD_URL, `_blank`, `noopener`);
            answer(place, `joined`);
        },
    };
};

export const useCommunityInvite = (): CommunityInvite => {
    // Detached: the reads behind it live as long as the window, not as long as the first menu that drew the row.
    instance ??= effectScope(true).run(create);
    if (instance === undefined) {
        throw new Error(`community invite: the detached scope ran nothing`);
    }
    return instance;
};
