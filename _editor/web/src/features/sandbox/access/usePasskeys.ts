import type { PasskeysList } from "@intentic/sandbox-contract";
import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { browserSupportsPasskeys, createPasskey } from "../../../client/session/passkeySignIn";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { readFailure } from "../../../client/sandbox/useDaemonRoutes";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useOperation } from "../../../workbench/operations/operations";

// The passkeys registered with the active sandbox, as the Access tab manages them: one's own (everyone's, for the
// owner), the owner's require switch, and the recovery codes that switch hands out. Adding one rides the ordinary
// authenticated client; the daemon binds the passkey to whoever the bearer is.

const EMPTY: PasskeysList = { passkeys: [], required: false };

export function usePasskeys() {
    const { active } = useSandbox();
    const { adoptSession } = useSandboxSession();
    const list = ref<PasskeysList>(EMPTY);
    // Adding a passkey, and the two writes that mint recovery codes, are the sandbox's in the operations ledger: the
    // section opened again mid-write holds its buttons. The codes are shown once and never refetchable, so the run
    // that minted them is kept until the owner says they are saved (`forgetCodes`), per sandbox.
    const adding = useOperation(`access/passkeys/add`);
    const minting = useOperation<readonly string[] | undefined>(`access/passkeys/codes`);
    const codes = computed(() => (minting.operation.value?.state === `done` ? minting.value.value : undefined));
    const forgetCodes = (): void => minting.dismiss();
    const busy = computed(() => adding.busy.value || minting.busy.value);
    // A remove refused, said here: quick, and the list read again after it is the answer either way.
    const removeNotice = ref<NoticeModel | undefined>(undefined);
    const notice = computed(() => removeNotice.value ?? adding.failure.value ?? minting.failure.value);
    const supported = browserSupportsPasskeys();

    // Why the list could not be read; the rule's state is then unknown, so the section must not draw it as off.
    const unread = ref<NoticeModel | undefined>(undefined);

    // A list that cannot be read, or one in a shape this page does not know, reads as no passkeys rather than a broken
    // tab, and says so (`unread`): the rule's state is then unknown, never drawn as off.
    const refresh = async (): Promise<void> => {
        try {
            list.value = await sandboxRaw(`GET /system/passkeys`);
            unread.value = undefined;
        } catch (caught) {
            list.value = EMPTY;
            unread.value = noticeFrom(new Error(readFailure(caught)), t(`sandbox.passkeysSection.couldntReadPasskeys`));
        }
    };

    watch(
        () => active.value?.id,
        () => {
            removeNotice.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    // Quiet: the new row in the list is the answer, and the browser's own passkey prompt was the wait.
    const add = async (label: string): Promise<void> => {
        if (busy.value) {
            return;
        }
        removeNotice.value = undefined;
        await adding.run({
            what: t(`sandbox.passkeysSection.addingPasskey`),
            failed: t(`sandbox.passkeysSection.couldntAddPasskey`),
            quiet: true,
            task: async () => {
                const options = await sandboxRaw(`POST /system/passkeys/register/options`);
                const response = await createPasskey(options);
                const trimmed = label.trim();
                const registered = await sandboxRaw(`POST /system/passkeys/register`, { input: trimmed === `` ? { response } : { response, label: trimmed } });
                // The upgraded session is kept, so switching the rule on right after does not ask for the passkey again.
                const sandboxId = active.value?.id;
                if (registered.session !== undefined && sandboxId !== undefined) {
                    adoptSession(sandboxId, registered.session);
                }
                await refresh();
            },
        });
    };

    // Not a ledger run: removing must not flash the add button's busy state, and the list read again is its answer.
    const remove = async (id: string): Promise<void> => {
        removeNotice.value = undefined;
        try {
            await sandboxRaw(`DELETE /system/passkeys/{id}`, { params: { id } });
        } catch (caught) {
            removeNotice.value = noticeFrom(caught, t(`sandbox.passkeysSection.couldntRemovePasskey`));
        }
        await refresh();
    };

    // Switching the rule on answers with the recovery codes; off answers with none, which puts any on screen away.
    const setRequired = async (required: boolean): Promise<void> => {
        if (busy.value) {
            return;
        }
        removeNotice.value = undefined;
        await minting.run({
            what: required ? t(`sandbox.passkeysSection.requirePasskey`) : t(`sandbox.passkeysSection.stopRequiring`),
            failed: t(`sandbox.passkeysSection.couldntChangeRule`),
            keep: required,
            quiet: !required,
            task: async () => {
                const result = await sandboxRaw(`POST /system/passkeys/policy`, { input: { required } });
                await refresh();
                return result.codes;
            },
        });
    };

    const regenerateCodes = async (): Promise<void> => {
        if (busy.value) {
            return;
        }
        removeNotice.value = undefined;
        await minting.run({
            what: t(`sandbox.passkeysSection.newCodes`),
            failed: t(`sandbox.passkeysSection.couldntMintCodes`),
            keep: true,
            task: async () => {
                const minted = (await sandboxRaw(`POST /system/passkeys/recovery`)).codes;
                await refresh();
                return minted;
            },
        });
    };

    return { list, unread, codes, forgetCodes, busy, notice, supported, add, remove, setRequired, regenerateCodes, refresh };
}
