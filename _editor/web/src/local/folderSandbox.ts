import { sandboxRef } from "@intentic/extension-api";
import { readonly, type Ref } from "vue";
import { LOCAL_SANDBOX_EVENT, localFace } from "../app/environments/local";

// WHETHER THIS WINDOW'S FOLDER HAS ITS OWN SANDBOX: what the window was opened with (`face.sandbox`, the app's
// projects.json), and true from the moment the app says one was made for it (`intentic:sandbox`, its project.rs
// `remember`), without a reload. "Work on this with an agent" becomes the way to that sandbox, and its bring-back
// appears (LocalFiles.vue). A folder never stops having one while its window is open: a sandbox removed elsewhere is
// found out by the press that opens it. Scoped to the folder: another one pointed at in this window's place
// (folderSwitch.ts) starts again from what its own face says.

const hasSandbox = sandboxRef(() => localFace()?.sandbox === true);
let listening = false;

const heard = (): void => {
    hasSandbox.value = true;
};

export const useFolderSandbox = (): Readonly<Ref<boolean>> => {
    if (!listening && typeof window !== `undefined`) {
        listening = true;
        window.addEventListener(LOCAL_SANDBOX_EVENT, heard);
    }
    return readonly(hasSandbox);
};
