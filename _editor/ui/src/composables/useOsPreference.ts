import { type Ref } from "vue";
import type { ShikiLang } from "../lib/shikiLangs.js";
import { definePreference } from "./preference.js";

export type CommandOs = "unix" | "windows";

const STORAGE_KEY = `ui-command-os`;

/* Owns the preferred OS for command examples as an account preference (composables/preference.ts), so the
 * Linux/Windows toggle stays in sync across every screen that shows a command and every window showing one.
 * Seeded from the browser platform, then persisted once the user picks one. */

// `startsWith`, not a /win/ match, "Darwin" contains "win".
const detect = (): CommandOs => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    return platform.toLowerCase().startsWith(`win`) ? `windows` : `unix`;
};

const cmdOs: Ref<CommandOs> = definePreference<CommandOs>({
    key: STORAGE_KEY,
    read: (raw) => (raw === `unix` || raw === `windows` ? raw : detect()),
    write: (value) => value,
});

export function useOsPreference() {
    return { cmdOs };
}

/* The two options every command block offers, and the Shiki grammar each implies. They ship from here, beside
 * the preference itself, because three screens were writing both out by hand, the sandbox switcher's cleanup
 * command, the connect-a-host step and the setup wizard, and a fourth would have had to guess whether the
 * label is "Windows (PowerShell)" or "Windows", and whether the lang id is `powershell` or `ps1`. The MARKUP
 * is deliberately not shared: one of the three wraps these in a third "Docker Compose" option with its own
 * component behind it, so a component here would have to grow a slot for a case only one caller has.
 *
 * Mutable, because <SegmentedControl> takes its options array as-is (same reason as RANGE_PRESETS in usageChart). */
export const OS_OPTIONS: { label: string; value: CommandOs }[] = [
    { label: `Linux / macOS`, value: `unix` },
    { label: `Windows (PowerShell)`, value: `windows` },
];

export const commandLang = (os: CommandOs): ShikiLang => (os === `windows` ? `powershell` : `bash`);
