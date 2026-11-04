import { sandboxRef } from "@intentic/extension-api";
import { audienceOfMode, DEFAULT_SANDBOX_MODE, type SandboxMode } from "@intentic/sandbox-contract/schemas/sandbox-mode";
import { computed, type ComputedRef, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// Who the screen is written for. A developer reads git's own words (branch, land, commit, diff) and every panel; a
// maker reads plain ones (draft, accept, version, what changed) over the same mechanisms, with tooling files, the index
// and the terminal out of the way. Nothing an agent does depends on it.
//
// THE SANDBOX DECIDES IT (2026-11). A hands-off sandbox speaks plain words and a hands-on one git's, to everyone on it
// who has not chosen otherwise for themselves. A person's own choice is kept by the sandbox per member
// (`settings.audience`, audienceSync.ts), so it holds on every device they open that sandbox on and on no other sandbox.
// Before this the browser held one answer and handed it to every sandbox it opened, so a single click on the first one
// decided the words on sandboxes it was never given for.
//
// This browser's copy (`ui-audience`) is only what paints before the sandbox answers: the words it was last told.

export type Audience = "developer" | "maker";

const STORAGE_KEY = `ui-audience`;

const isAudience = (value: unknown): value is Audience => value === `developer` || value === `maker`;

// The words on screen. Unset reads as developer, so everyone who arrived before the sandbox said anything keeps the
// screens they had.
const audience: Ref<Audience> = definePreference<Audience>({
    key: STORAGE_KEY,
    read: (raw) => (isAudience(raw) ? raw : `developer`),
    write: (value) => value,
});

// What the current sandbox said: how it runs, and this person's own choice of words there. Both cleared on a switch;
// `mode` stays undefined on a daemon from before the mode, which keeps only a person's choice.
const mode = sandboxRef<SandboxMode | undefined>(() => undefined);
const override = sandboxRef<Audience | undefined>(() => undefined);

const maker: ComputedRef<boolean> = computed(() => audience.value === `maker`);

// Where a choice is kept beyond this window, once the app has registered it (audienceSync.ts); absent in a window that
// never attached a sandbox, and in tests.
let keeper: ((value: Audience | null) => void) | undefined;

export const keepAudienceWith = (keep: ((value: Audience | null) => void) | undefined): void => {
    keeper = keep;
};

/** What a sandbox answered about this person's words there. */
export interface SandboxWords {
    readonly audience: Audience;
    readonly override?: Audience | undefined;
    readonly mode?: SandboxMode | undefined;
}

// The sandbox's answer, taken whole and never sent back.
export const adoptSandboxWords = (words: SandboxWords): void => {
    mode.value = words.mode;
    override.value = words.override;
    audience.value = words.audience;
};

// Somebody choosing here: their own words on this sandbox, or null to follow how it runs again. Worn at once, then kept
// by the sandbox, whose answer replaces this one when it lands.
const setAudience = (value: Audience | null): void => {
    override.value = value ?? undefined;
    audience.value = value ?? audienceOfMode(mode.value ?? DEFAULT_SANDBOX_MODE);
    keeper?.(value);
};

export function useAudience() {
    return { audience, maker, mode, override, setAudience };
}
