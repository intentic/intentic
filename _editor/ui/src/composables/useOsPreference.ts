import type { Ref } from "vue";
import type { ShikiLang } from "@intentic/code-read/langs";
import { definePreference } from "./preference.js";

export type CommandOs = "unix" | "windows";

const STORAGE_KEY = `ui-command-os`;

// Owns the preferred OS for command examples as an account preference, so the Linux/Windows toggle
// stays in sync across every screen and window. Seeded from the browser platform, then persisted once chosen.

// `startsWith`, not a /win/ match: "Darwin" contains "win".
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

// The two options every command block offers, and the Shiki grammar each implies, shared here since
// three call sites otherwise guess at the label and lang id. Mutable, since <SegmentedControl> takes
// its options array as-is.
export const OS_OPTIONS: { label: string; value: CommandOs }[] = [
    { label: `Linux / macOS`, value: `unix` },
    { label: `Windows (PowerShell)`, value: `windows` },
];

export const commandLang = (os: CommandOs): ShikiLang => (os === `windows` ? `powershell` : `bash`);
