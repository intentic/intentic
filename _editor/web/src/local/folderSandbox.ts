import { sandboxRef } from "@intentic/extension-api";
import { readonly, ref, type Ref } from "vue";
import { LOCAL_HOLDER_EVENT, LOCAL_SANDBOX_EVENT, LOCAL_SANDBOX_OPENING_EVENT, localFace } from "../app/environments/local";
import { heldAnew, openingStage } from "./appEvents";

// WHETHER THIS WINDOW'S FOLDER HAS ITS OWN SANDBOX: what the window was opened with (`face.sandbox`, the app's
// projects.json), and true from the moment the app says one was made for it (`intentic:sandbox`, its project.rs
// `remember`), without a reload. "Work on this with an agent" becomes the way to that sandbox, and its bring-back
// appears (LocalFiles.vue). A sandbox removed elsewhere is found out by the press that opens it. Scoped to the folder:
// another one pointed at in this window's place (folderSwitch.ts) starts again from what its own face says.
//
// AND WHOSE IT IS (2026-10-25): a folder synced with a sandbox of another account than the one signed in is not this
// account's to open, and must not be given a second sandbox either; its button says whose instead (`face.otherAccount`,
// `face.owner`). Both follow a sign-in, a sign-out or a switch as the app says them (`intentic:holder`).

/** The folder is synced with another account's sandbox: that account, when the app knows it. */
export interface OtherAccount {
    readonly owner: string | undefined;
}

const otherOf = (): OtherAccount | undefined => {
    const face = localFace();
    return face?.otherAccount === true ? { owner: face.owner } : undefined;
};

const hasSandbox = sandboxRef(() => localFace()?.sandbox === true);
const otherAccount = sandboxRef<OtherAccount | undefined>(otherOf);
let listening = false;

const heard = (): void => {
    hasSandbox.value = true;
    otherAccount.value = undefined;
};

const heldNow = (event: Event): void => {
    const held = heldAnew(event);
    if (held === undefined) {
        return;
    }
    hasSandbox.value = held.sandbox;
    otherAccount.value = held.otherAccount ? { owner: held.owner ?? undefined } : undefined;
};

const listen = (): void => {
    if (!listening && typeof window !== `undefined`) {
        listening = true;
        window.addEventListener(LOCAL_SANDBOX_EVENT, heard);
        window.addEventListener(LOCAL_HOLDER_EVENT, heldNow);
    }
};

export const useFolderSandbox = (): Readonly<Ref<boolean>> => {
    listen();
    return readonly(hasSandbox);
};

/** Whose the folder's sandbox is when it is another account's; undefined when it is this account's, or there is none. */
export const useOtherAccount = (): Readonly<Ref<OtherAccount | undefined>> => {
    listen();
    return readonly(otherAccount);
};

// THE FOLDER'S SANDBOX ON ITS WAY TO THE SCREEN. "Open this folder's sandbox" is a link to the app, which looks first
// whether the sandbox is stopped (starting it when it is) and then puts the workspace up (project.rs `open_existing`).
// That took a second or two with nothing on screen moving, so the press read as missed (2026-10-17). The button now
// says `opening` from the press on, `starting` when the app says it is starting a stopped sandbox, and goes back to
// rest when the app says the workspace is up. A deadline puts it back too, so an answer that never comes (a page with
// no app behind it, an older app) cannot hold the button for good.

export type SandboxOpening = `opening` | `starting`;

// How long each stage holds without the app's word: opening is a listing and a window, starting a container's boot.
const OPENING_FOR_MS = 15_000;
const STARTING_FOR_MS = 120_000;

// allow(module-state): one folder per window, so one press on its way.
const stage = ref<SandboxOpening | undefined>(undefined);
let deadline: ReturnType<typeof setTimeout> | undefined;
let openingHeard = false;

const settle = (): void => {
    clearTimeout(deadline);
    deadline = undefined;
    stage.value = undefined;
};

const hold = (next: SandboxOpening): void => {
    clearTimeout(deadline);
    stage.value = next;
    deadline = setTimeout(settle, next === `starting` ? STARTING_FOR_MS : OPENING_FOR_MS);
};

const heardOpening = (event: Event): void => {
    const said = openingStage(event);
    if (said === `starting`) {
        hold(`starting`);
    } else if (said === `shown`) {
        settle();
    }
};

/** The folder's sandbox on its way up: how far, a press's start, and its end when the page itself knows it. */
export interface SandboxOpeningState {
    readonly stage: Readonly<Ref<SandboxOpening | undefined>>;
    begin(): void;
    settle(): void;
}

export const useSandboxOpening = (): SandboxOpeningState => {
    if (!openingHeard) {
        openingHeard = true;
        window.addEventListener(LOCAL_SANDBOX_OPENING_EVENT, heardOpening);
    }
    return { stage: readonly(stage), begin: () => hold(`opening`), settle };
};
