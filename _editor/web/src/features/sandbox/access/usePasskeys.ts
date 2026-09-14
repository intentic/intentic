import { type PasskeysList, PasskeysListSchema, type RegistrationOptionsJSON } from "@intentic/sandbox-contract";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import { ref, watch } from "vue";
import { jsonBody } from "../client/jsonBody";
import { browserSupportsPasskeys, createPasskey, type PasskeyRegistered } from "../client/passkeySignIn";
import { sandboxJson } from "../client/sandboxClient";
import { useSandboxSession } from "../client/sandboxSession";
import { useSandbox } from "../client/useSandbox";

// The passkeys registered with the active sandbox, as the Access tab manages them: one's own (everyone's, for the
// owner), the owner's require switch, and the recovery codes that switch hands out. Adding one rides the ordinary
// authenticated client; the daemon binds the passkey to whoever the bearer is.

const EMPTY: PasskeysList = { passkeys: [], required: false };

export function usePasskeys() {
    const { active } = useSandbox();
    const { adoptSession } = useSandboxSession();
    const list = ref<PasskeysList>(EMPTY);
    // The last set of recovery codes minted here; shown once, cleared on navigation or sandbox switch, never refetchable.
    const codes = ref<readonly string[] | undefined>(undefined);
    const { busy, notice, run } = useAsyncAction();
    const supported = browserSupportsPasskeys();

    // A daemon that predates the route, or answers something else, reads as no passkeys rather than a broken tab.
    const refresh = async (): Promise<void> => {
        try {
            list.value = PasskeysListSchema.safeParse(await sandboxJson<unknown>(`/system/passkeys`)).data ?? EMPTY;
        } catch {
            list.value = EMPTY;
        }
    };

    watch(
        () => active.value?.id,
        () => {
            codes.value = undefined;
            notice.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    const add = (label: string): Promise<void> =>
        run(async () => {
            const options = await sandboxJson<RegistrationOptionsJSON>(`/system/passkeys/register/options`, jsonBody(`POST`, {}));
            const response = await createPasskey(options);
            const trimmed = label.trim();
            const registered = await sandboxJson<PasskeyRegistered>(
                `/system/passkeys/register`,
                jsonBody(`POST`, { response, ...(trimmed === `` ? {} : { label: trimmed }) }),
            );
            // The upgraded session is kept, so switching the rule on right after does not ask for the passkey again.
            if (registered.session !== undefined && active.value !== undefined) {
                adoptSession(active.value.id, registered.session);
            }
            await refresh();
        }, `Couldn't add the passkey.`);

    // Not routed through `run`: removing must not flash the add button's busy state.
    const remove = async (id: string): Promise<void> => {
        try {
            await sandboxJson(`/system/passkeys/${encodeURIComponent(id)}`, { method: `DELETE` });
        } catch (caught) {
            notice.value = noticeFrom(caught, `Couldn't remove that passkey.`);
        }
        await refresh();
    };

    const setRequired = (required: boolean): Promise<void> =>
        run(async () => {
            const result = await sandboxJson<{ required: boolean; codes?: string[] }>(`/system/passkeys/policy`, jsonBody(`POST`, { required }));
            codes.value = result.codes;
            await refresh();
        }, `Couldn't change the passkey rule.`);

    const regenerateCodes = (): Promise<void> =>
        run(async () => {
            codes.value = (await sandboxJson<{ codes: string[] }>(`/system/passkeys/recovery`, jsonBody(`POST`, {}))).codes;
            await refresh();
        }, `Couldn't mint new recovery codes.`);

    return { list, codes, busy, notice, supported, add, remove, setRequired, regenerateCodes, refresh };
}
