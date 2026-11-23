import type { Disposable } from "@intentic/extension-api";
import { type Component, shallowRef } from "vue";

// What a Workspace skill tab draws (SkillPage.vue, the Settings feature's), handed over by the shell: the Workspace pane
// importing the Settings feature directly closed a cycle between the two (editor-boundaries), since Settings already
// opens tabs here. Unset until the desktop shell mounts, which is the only shell whose Workspace draws a skill tab.

// allow(module-state): the one component the shell registers for every pane to draw, retired when the shell unmounts
const view = shallowRef<Component | undefined>();

export const registerSkillView = (component: Component): Disposable => {
    view.value = component;
    return {
        dispose: (): void => {
            if (view.value === component) {
                view.value = undefined;
            }
        },
    };
};

export const skillView = (): Component | undefined => view.value;
