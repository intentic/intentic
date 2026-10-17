import { runBounded } from "@intentic/base/process";
import { PS_UTF8_OUTPUT, psText } from "@intentic/desktop-automation";
import { z } from "zod";

// ONE REGISTRY VALUE, READ AS STORED. Through PowerShell rather than `reg query`: reg.exe prints its listing in the
// console's OEM code page (852 on a Polish Windows), which a UTF-8 read turns into U+FFFD for every non-ASCII letter,
// and a value read wrong here is written back wrong (install.ts) or never matches what it should (upkeep/login.ts).
// PowerShell answers JSON in UTF-8 (PS_UTF8_OUTPUT), with the value unexpanded and its kind as .NET names it.

export interface RegistryValue {
    // reg.exe's name for the kind (REG_SZ, REG_EXPAND_SZ, …), since that is what `reg add /t` takes back.
    readonly kind: string;
    readonly data: string;
}

// `GetValueKind` names, as reg.exe spells them; one not listed is carried under its .NET name.
const REG_KINDS = new Map([
    ["String", "REG_SZ"],
    ["ExpandString", "REG_EXPAND_SZ"],
    ["MultiString", "REG_MULTI_SZ"],
    ["DWord", "REG_DWORD"],
    ["QWord", "REG_QWORD"],
    ["Binary", "REG_BINARY"],
    ["None", "REG_NONE"],
]);

// `Stop`, so a key that cannot be opened fails the read: an absent value and an unreadable one must not look alike when
// the caller writes the value back. A value name is matched case-insensitively, as Windows does. Pure.
export const registryValueScript = (key: string, name: string): string =>
    `${PS_UTF8_OUTPUT}$ErrorActionPreference = 'Stop';
$k = Get-Item -LiteralPath ${psText(key)};
$v = $k.GetValue(${psText(name)}, $null, 'DoNotExpandEnvironmentNames');
$kind = if ($null -eq $v) { '' } else { [string]$k.GetValueKind(${psText(name)}) };
ConvertTo-Json -Compress -InputObject @{ kind = $kind; data = [string]$v };`;

const AnswerSchema = z.object({ kind: z.string(), data: z.string() });

// The value out of what registryValueScript printed: undefined when there is none, and a throw for an answer that is
// not one, since a caller writing the value back must not take it for absent. Pure.
export const registryValueFrom = (answer: string): RegistryValue | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(answer.trim());
    } catch {
        throw new Error(`PowerShell's answer about the registry is not JSON: ${answer.trim().slice(0, 200)}`);
    }
    const read = AnswerSchema.safeParse(parsed);
    if (!read.success) {
        throw new Error(`PowerShell's answer about the registry has no kind and data: ${answer.trim().slice(0, 200)}`);
    }
    return read.data.kind === "" ? undefined : { kind: REG_KINDS.get(read.data.kind) ?? read.data.kind, data: read.data.data };
};

export const readRegistryValue = async (key: string, name: string): Promise<RegistryValue | undefined> => {
    const read = await runBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryValueScript(key, name)], { timeoutMs: 30_000 });
    if (read.spawnError !== undefined) {
        throw read.spawnError;
    }
    if (read.exitCode !== 0) {
        const said = read.stderr.text.trim();
        throw new Error(said === "" ? `PowerShell exited ${String(read.exitCode)} reading ${key}` : said);
    }
    return registryValueFrom(read.stdout.text);
};
