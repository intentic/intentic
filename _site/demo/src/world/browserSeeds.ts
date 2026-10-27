// WHAT THE VISITOR'S BROWSER ALREADY HOLDS FOR A SANDBOX when the demo hands it one, written where the editor reads it
// rather than faked: the local shortcut's offer already declined, since no sandbox of the demo's world runs on the
// visitor's own computer and the offer could only fail its loopback probe.

/** The browser already said no to the "Faster if this sandbox runs on this device" offer for this sandbox. */
export const declineLocalShortcut = (sandboxId: string): void => {
    localStorage.setItem(`intentic.localShortcut.declined.${sandboxId}`, `yes`);
};
