import { resetSandboxScope, sandboxRef } from "@intentic/extension-api";
import { watch } from "vue";
import { loadArchived } from "../../agents/fleet/useAgents-registry";
import { loadAccountStatus } from "../../chat/accounts/useChat-accounts";
import { useSandbox } from "./useSandbox";

// The one place a sandbox switch resets anything: every module-level value about one sandbox is declared through the
// scope primitive (sandboxRef, sandboxValue), the editor's and the extensions' alike, and comes back as its initial
// here. Module scope, not the shell's, since the active sandbox can change while the shell is unmounted (add-sandbox).

const { activeSandboxId, reachable } = useSandbox();

watch(activeSandboxId, (id, previous) => {
    if (id !== previous) {
        resetSandboxScope();
    }
});

// Minted fresh per scope, so the reads below follow every new one: a switch, or the workspace replaced under the same
// sandbox id (systemEvents.ts), whose reset has no id change to watch.
const scope = sandboxRef(() => ({}));

// Reloads what lives on the daemon on first reachability, a reconnect, or a new scope (a switch between two
// already-healthy boxes flips no reachability at all). Runs after the reset above.
watch([reachable, scope], ([isReachable]) => {
    if (isReachable) {
        void loadAccountStatus();
        // Pull-only, rides the same seam: a reachable daemon may have archived agents itself since the last read.
        void loadArchived();
    }
});

// Held wakes are pull-only too, but reading them here doesn't work: the revision line moves twice on a switch
// (this reset, then the new hello), and a read fired between the two lands on a line nobody is on and is
// discarded. That read belongs after the hello, in systemEvents.
