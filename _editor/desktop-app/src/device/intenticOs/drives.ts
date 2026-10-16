import { activeLocale, t } from "@intentic/ui/i18n";
import { ref, watch } from "vue";
import { runStop } from "../../desktop";
import { OS_DRIVE_IMPORT_RUN, onOsDriveImport, onOsDrives, osDriveEject, osDriveImport, osDrivesList, osDrivesSeen, osDriveWords, type OsDriveImportEnd, type OsDriveImportEvent, type OsDrivesSeen, type OsDriveWords } from "../../osSettings";
import { copyEndOf, foldCopy, type Copying } from "./drivesCard";

// THE DRIVES A PERSON PLUGS IN (src-tauri/src/os_settings.rs watches `ic os drives` on a thread of its own): the list as
// the app last read it and every change to it (`desktop://os-drives`), which of them arrived since the reader last looked
// (the card lights those up), a copy into a sandbox as every window hears it (`desktop://os-drive-import`) and how it
// ended, and an eject. The app's notification for a new drive is in the reader's language: each window hands over its
// words as it starts and again when the language changes (`startDrives`). DrivesCard.vue draws it; on a computer that
// is not Intentic OS there is nothing here and no card.

/** The drives plugged in, and which are fresh; undefined on a computer that is not Intentic OS, and until read. */
export const drives = ref<OsDrivesSeen | undefined>(undefined);
/** A copy under way, this window's or another's. */
export const copying = ref<Copying | undefined>(undefined);
/** How the last copy ended, until the reader puts it away or another begins. */
export const copyEnd = ref<OsDriveImportEnd | undefined>(undefined);
/** A copy asked for here that never ran, in the app's words. */
export const copyError = ref<string | undefined>(undefined);
/** The drive being ejected. */
export const ejecting = ref<string | undefined>(undefined);
/** What the drive just ejected is called: it can be pulled out now. */
export const ejected = ref<string | undefined>(undefined);
/** An eject that did not work, in ic's words (a file still open on the drive, most often), and what it is called. */
export const ejectError = ref<{ readonly device: string; readonly name: string; readonly reason: string } | undefined>(undefined);

export const loadDrives = async (): Promise<void> => {
    try {
        drives.value = (await osDrivesList()) ?? undefined;
    } catch (error) {
        console.error(`[device] the drives could not be read:`, error);
    }
};

/** The list again, from the app's watcher. A drive that left takes what was said about it with it.
 *  @public: heard by `startDrives`, and driven by its tests through a fresh import. */
export const hearDrives = (seen: OsDrivesSeen): void => {
    drives.value = seen;
    const here = (device: string | undefined): boolean => device !== undefined && seen.drives.some((drive) => drive.device === device);
    if (!here(ejectError.value?.device)) {
        ejectError.value = undefined;
    }
};

/** One moment of a copy, from whichever window started it.
 *  @public: heard by `startDrives`, and driven by its tests through a fresh import. */
export const hearCopy = (event: OsDriveImportEvent): void => {
    if (event.kind === `started`) {
        copyEnd.value = undefined;
        copyError.value = undefined;
    }
    copying.value = foldCopy(copying.value, event);
    const end = copyEndOf(event);
    if (end !== undefined) {
        copyEnd.value = end;
    }
};

/** Copy everything on `device` into the sandbox `sandbox`, into `folder` inside its /work where one is named. As long as
 *  the copy takes: the card follows its progress, and every window with it. */
export const copyDrive = async (device: string, sandbox: string, folder?: string): Promise<void> => {
    if (copying.value !== undefined) {
        return;
    }
    copyEnd.value = undefined;
    copyError.value = undefined;
    ejected.value = undefined;
    copying.value = { device, sandbox, bytes: 0, total: 0 };
    let end: OsDriveImportEnd | undefined;
    try {
        end = await osDriveImport(device, sandbox, folder);
    } catch (error) {
        copyError.value = String(error);
    }
    // Its last event may have said all this already. Refused because another window's copy runs, that one goes on: its
    // next progress puts it back on the card.
    copyEnd.value = end;
    if (copying.value?.device === device) {
        copying.value = undefined;
    }
};

/** Stop the copy under way, with everything it started. */
export const stopCopy = async (): Promise<void> => {
    try {
        await runStop(OS_DRIVE_IMPORT_RUN);
    } catch (error) {
        copyError.value = String(error);
    }
};

/** Put away how the last copy ended. */
export const dismissCopy = (): void => {
    copyEnd.value = undefined;
    copyError.value = undefined;
};

/** Write out what is still on its way to the drive and power it off, so it can be pulled out. `name` is what the card
 *  calls it, for the line that says it can go. */
export const ejectDrive = async (device: string, name: string): Promise<void> => {
    if (ejecting.value !== undefined) {
        return;
    }
    ejecting.value = device;
    ejectError.value = undefined;
    ejected.value = undefined;
    try {
        await osDriveEject(device);
        ejected.value = name;
    } catch (error) {
        ejectError.value = { device, name, reason: String(error) };
    } finally {
        ejecting.value = undefined;
    }
};

/** The reader has seen these on the Drives card: lit up no more, and the app takes their notifications down. */
export const markSeen = async (devices: readonly string[]): Promise<void> => {
    if (devices.length === 0) {
        return;
    }
    try {
        await osDrivesSeen(devices);
    } catch (error) {
        console.error(`[device] the drives could not be marked as seen:`, error);
    }
};

/** The notification's words, in the reader's language now. `{name}` stays for the app to fill in. */
const driveWords = (): OsDriveWords => {
    const name = { name: `{name}` };
    return {
        usbNamed: t(`desktop.os.drives.notice.usbNamed`, name),
        usb: t(`desktop.os.drives.notice.usb`),
        cardNamed: t(`desktop.os.drives.notice.cardNamed`, name),
        card: t(`desktop.os.drives.notice.card`),
        otherNamed: t(`desktop.os.drives.notice.otherNamed`, name),
        other: t(`desktop.os.drives.notice.other`),
        body: t(`desktop.os.drives.notice.body`),
    };
};

const handOverWords = async (): Promise<void> => {
    try {
        await osDriveWords(driveWords());
    } catch (error) {
        console.error(`[device] the drive notification's words could not be handed over:`, error);
    }
};

let started: Promise<void> | undefined;

/** Follow the drives and every copy, and hand the app this window's words: once per window, as the window starts. */
export const startDrives = (): Promise<void> =>
    (started ??= (async () => {
        await Promise.all([onOsDrives(hearDrives), onOsDriveImport(hearCopy)]);
        watch(activeLocale, () => void handOverWords());
        await Promise.all([handOverWords(), loadDrives()]);
    })());
