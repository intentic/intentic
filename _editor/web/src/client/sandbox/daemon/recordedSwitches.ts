import { sandboxRef } from "@intentic/extension-api";

// Whether the active daemon writes a `switched` notice into a conversation's record on every turn that goes out on
// another provider, account, loop or model than the turn before it, off its /events hello's `recordsSwitches`. False
// until a hello says so, which is also every daemon from before the field: with one of those the chat's own divider is
// the only line that says a send switched, so it stays in the transcript once the send goes out (ComposerSelection).
// Sandbox-scoped like the route list beside it.
const advertised = sandboxRef<boolean>(() => false);

// Called on every hello frame.
export const setRecordsSwitches = (records: boolean | undefined): void => {
    advertised.value = records === true;
};

// Whether the record says which turn switched, so a divider this window drew only previews it until the send.
export const daemonRecordsSwitches = (): boolean => advertised.value;
