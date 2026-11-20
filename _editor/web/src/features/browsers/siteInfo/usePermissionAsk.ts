import type { BrowserPermissionAsk } from "@intentic/sandbox-contract/schemas/browser-tools";
import { errorMessage } from "@intentic/base/errors";
import { ref, type Ref } from "vue";
import type { WindowToolsSeams } from "../windowTools";

// A site's permission ask, answered in the view's own prompt (PermissionPrompt.vue) where Chromium's bubble would be.
// Allowing a site to know where the person is asks their own browser where that is, and the page is told that.

export const usePermissionAsk = (seams: WindowToolsSeams, window: Ref<string | undefined>, ask: Ref<BrowserPermissionAsk | undefined>) => {
    const answering = ref(false);
    const error = ref<string | undefined>();
    const answer = async (setting: `allow` | `block`): Promise<void> => {
        const asked = ask.value;
        const name = window.value;
        if (asked === undefined || name === undefined || answering.value) {
            return;
        }
        answering.value = true;
        error.value = undefined;
        try {
            const location = setting === `allow` && asked.permission === `geolocation` ? await seams.locate() : undefined;
            await seams.browser.answerPermission(location === undefined ? { name, ask: asked.id, setting } : { name, ask: asked.id, setting, location });
        } catch (caught) {
            error.value = errorMessage(caught);
        } finally {
            answering.value = false;
        }
    };
    return { ask, answer, answering, error };
};

export type PermissionAskTools = ReturnType<typeof usePermissionAsk>;
