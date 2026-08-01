import { ref, watch, type Ref } from "vue";

export type CommandOs = "unix" | "windows";

const STORAGE_KEY = `ui-command-os`;

/* Owns the preferred OS for command examples as a module-level singleton, so the Linux/Windows toggle
 * stays in sync across every screen that shows a command. Seeded from the browser platform, then persisted
 * once the user picks one — reads fall back to detection until a choice is stored. */

// `startsWith`, not a /win/ match — "Darwin" contains "win".
const detect = (): CommandOs => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    return platform.toLowerCase().startsWith(`win`) ? `windows` : `unix`;
};

const read = (): CommandOs => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === `unix` || stored === `windows`) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to platform detection.
    }
    return detect();
};

const cmdOs: Ref<CommandOs> = ref(read());

// Persist every change, including `Segmented` v-model writes, so no page needs an explicit setter.
watch(cmdOs, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useOsPreference() {
    return { cmdOs };
}

/* The two options every command block offers, and the Shiki grammar each implies. They ship from here, beside
 * the preference itself, because three screens were writing both out by hand — the sandbox switcher's cleanup
 * command, the connect-a-host step and the setup wizard — and a fourth would have had to guess whether the
 * label is "Windows (PowerShell)" or "Windows", and whether the lang id is `powershell` or `ps1`. The MARKUP
 * is deliberately not shared: one of the three wraps these in a third "Docker Compose" option with its own
 * component behind it, so a component here would have to grow a slot for a case only one caller has.
 *
 * Mutable, because <Segmented> takes its options array as-is (same reason as RANGE_PRESETS in usageChart). */
export const OS_OPTIONS: { label: string; value: CommandOs }[] = [
    { label: `Linux / macOS`, value: `unix` },
    { label: `Windows (PowerShell)`, value: `windows` },
];

export const commandLang = (os: CommandOs): string => (os === `windows` ? `powershell` : `bash`);
