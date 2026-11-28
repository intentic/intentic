import type { S2sMe } from "@intentic/sandbox-contract/schemas/s2s";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { ref, shallowRef } from "vue";
import { S2S_ME } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";

// One write to this sandbox's identity at a time, its refusal said where it was pressed: each answers the identity as it
// now stands, which replaces the shared entry at once, so every part reading it agrees without reading it again.

export const useIdentityWrite = () => {
    const busy = ref<string>();
    const notice = shallowRef<NoticeModel>();
    const run = async (what: string, task: () => Promise<S2sMe | undefined>, failed: string): Promise<boolean> => {
        if (busy.value !== undefined) {
            return false;
        }
        busy.value = what;
        notice.value = undefined;
        try {
            const me = await task();
            if (me !== undefined) {
                queryClient.setQueryData(S2S_ME.of(), me);
            }
            return true;
        } catch (error) {
            notice.value = noticeFrom(error, failed);
            return false;
        } finally {
            busy.value = undefined;
        }
    };
    return { busy, notice, run };
};
