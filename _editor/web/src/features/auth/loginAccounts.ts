import { errorMessage } from "@intentic/base/errors";
import { computed, onMounted, type Ref, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDeviceAccounts } from "../../client/auth/deviceAccounts";
import { type DeviceSession, useAuth } from "../../client/auth/useAuth";

// THE SIGN-IN SCREEN AND THE BROWSER'S OTHER ACCOUNTS (client/auth/deviceAccounts.ts). Two moments:
// - ADDING ONE (`/login?add=1`, the account menu's "Add another account"): whoever signs in here joins the account already
//   signed in rather than replacing it, Google is asked which account rather than answering with the one it knows, and
//   the reader lands on Home as the account just added. Asked for by the address alone, so a reload of this page, which
//   no session check ran before, still adds rather than silently signing the first account back in.
// - NOBODY ACTIVE, OTHERS STILL SIGNED IN (the active one expired or was signed out elsewhere): each is offered as
//   "Continue as", one press, rather than a sign-in from scratch. Nothing switches account by itself.

export const useLoginAccounts = (destination: Readonly<Ref<string>>) => {
    const route = useRoute();
    const router = useRouter();
    const { user, refresh, listDeviceSessions } = useAuth();
    const { arriveAsAdded, continueAs } = useDeviceAccounts();

    const asked = computed(() => route.query[`add`] === `1`);
    // Who stays signed in while another is added, once known: what the screen names.
    const adding = computed(() => (asked.value ? user.value : null));
    const remaining = ref<readonly DeviceSession[]>([]);
    const failure = ref<string | undefined>(undefined);

    onMounted(async () => {
        if (asked.value && user.value === null) {
            // allow(silent-catch): an unanswered session check leaves the screen unnamed; the add still adds.
            await refresh().catch(() => undefined);
        }
        if (user.value === null) {
            // allow(silent-catch): an unanswered list offers no one to continue as; signing in is still on screen.
            remaining.value = await listDeviceSessions().catch((): readonly DeviceSession[] => []);
        }
    });

    /** Where a sign-in on this screen ends: on as the account just added, or on to where the guard was sending. */
    const arrive = async (): Promise<void> => {
        if (asked.value) {
            await arriveAsAdded(destination.value);
            return;
        }
        await router.replace(destination.value);
    };

    const continueWith = async (account: DeviceSession): Promise<void> => {
        failure.value = undefined;
        try {
            await continueAs(account, destination.value);
        } catch (error) {
            failure.value = errorMessage(error);
            remaining.value = remaining.value.filter((entry) => entry.token !== account.token);
        }
    };

    /** Leaves the add without adding: back where the reader came from, as the account still signed in. */
    const back = async (): Promise<void> => {
        await router.replace(destination.value);
    };

    return { asked, adding, remaining, failure, arrive, continueWith, back };
};
