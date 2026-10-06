import { t } from "@intentic/ui/i18n";

// What a device, a browser or a phone tile lets the agent do, as effects.ts lists it: English phrases, since the
// daemon and the agents read the same effects. These are the screen's words for them, filed under the package's
// phrase; a phrase with no entry (one the package gains later) is shown as the package spells it. grants.test.ts
// holds every phrase effects.ts can produce to an entry here.
const GRANT_WORDS: ReadonlyMap<string, () => string> = new Map([
    [`run commands`, () => t(`capabilities.grants.runCommands`)],
    [`read files`, () => t(`capabilities.grants.readFiles`)],
    [`write and trash files`, () => t(`capabilities.grants.writeAndTrashFiles`)],
    [`capture the screen`, () => t(`capabilities.grants.captureScreen`)],
    [`use the mouse and keyboard`, () => t(`capabilities.grants.useMouseAndKeyboard`)],
    [`start and stop its sandboxes`, () => t(`capabilities.grants.startAndStopSandboxes`)],
    [`read the pages you allow`, () => t(`capabilities.grants.readPagesYouAllow`)],
    [`click and type on them`, () => t(`capabilities.grants.clickAndType`)],
    [`take screenshots`, () => t(`capabilities.grants.takeScreenshots`)],
    [`hand a site's session to this sandbox`, () => t(`capabilities.grants.handSession`)],
    [`see the screen`, () => t(`capabilities.grants.seeScreen`)],
    [`tap, swipe and type in the apps you allow`, () => t(`capabilities.grants.tapSwipeType`)],
    [`read the folders you pick`, () => t(`capabilities.grants.readFoldersYouPick`)],
    [`change files in them`, () => t(`capabilities.grants.changeFilesInThem`)],
    [`read notifications`, () => t(`capabilities.grants.readNotifications`)],
    [`open apps and links`, () => t(`capabilities.grants.openAppsAndLinks`)],
]);

/** One grant in the reader's language. */
export const grantWords = (phrase: string): string => GRANT_WORDS.get(phrase)?.() ?? phrase;

/** A tile's grants as one run of words, for "Lets the agent …" and "Once connected, the agent may: …". */
export const grantList = (grants: readonly string[]): string => grants.map(grantWords).join(`, `);
