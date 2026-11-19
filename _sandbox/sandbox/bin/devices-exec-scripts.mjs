// The computer's half of `devices exec` (devices-exec.mjs): the script one run starts there, written into that run's
// stage folder with what it reads. It brings the mirror up to date, runs the command in it, and sets aside what the
// sandbox fetches back. A POSIX sh one for Linux, macOS and a WSL distro, a PowerShell one for Windows itself.
//
// The stage folder holds, beside the script:
//   vars        the mirror's path, the generation the sandbox expects there, the one it leaves, the folder to run in
//   command     the command, exactly as typed (no shell's quoting between here and there)
//   deleted     paths removed here since the mirror's generation, one per line, removed there first
//   needs       programs the command needs, checked before it runs: a toolchain missing there is said, not guessed at
//   fetch       paths to set aside into out/ once it has run, for the sandbox to copy back
//   delta.tar   the files whose bytes changed (absent when none did), unpacked with -m: fresh modification times, so an
//               incremental build (cargo, make, ninja) rebuilds what changed
//
// Lines starting "intentic-mirror: " are for the sandbox to read: stale (the mirror is not the generation expected,
// exit 86), synced, missing, absent, failed. Deleting is held to the mirror and this sandbox's own stage folders: a path
// that is absolute or climbs out with `..` is skipped. The command itself rides on the program's own command line too,
// so the computer's switches judge it as they judge run_command's.

// The exit code that says the mirror was not the generation the sandbox expected: it then sends everything again.
export const STALE_EXIT = 86;

// The run's own stage folders are named so; an older one of this sandbox's is removed by the next run, after the sandbox
// fetched from it.
export const STAGE_PREFIX = "run-";

export const RUN_SH = `# devices exec, on the computer: the sandbox's bin/devices-exec-scripts.mjs wrote this for one run.
stage=$(cd "$(dirname "$0")" && pwd) || exit 70
. "$stage/vars"
case "$MIRROR" in "~/"*) MIRROR="$HOME/\${MIRROR#??}" ;; esac
note() { printf 'intentic-mirror: %s\\n' "$*"; }
safe() { case "$1" in "" | /* | .. | ../* | */.. | */../*) return 1 ;; esac; return 0; }
for old in "$stage"/../${STAGE_PREFIX}*; do
    [ "\${old##*/}" = "\${stage##*/}" ] || rm -rf "$old"
done
mkdir -p "$MIRROR/.intentic-mirror" || { note "failed could not create $MIRROR"; exit 70; }
have=$(cat "$MIRROR/.intentic-mirror/generation" 2>/dev/null)
if [ -n "$EXPECT" ] && [ "$have" != "$EXPECT" ]; then note "stale $have"; exit ${STALE_EXIT}; fi
while IFS= read -r path || [ -n "$path" ]; do
    if safe "$path"; then rm -f "$MIRROR/$path"; fi
done <"$stage/deleted"
if [ -f "$stage/delta.tar" ]; then
    tar -xmf "$stage/delta.tar" -C "$MIRROR" || { note "failed could not unpack the changes into $MIRROR"; exit 70; }
    rm -f "$stage/delta.tar"
fi
printf '%s\\n' "$GENERATION" >"$MIRROR/.intentic-mirror/generation"
note "synced $GENERATION $MIRROR"
missing=""
while IFS= read -r tool || [ -n "$tool" ]; do
    if [ -n "$tool" ] && ! command -v "$tool" >/dev/null 2>&1; then missing="$missing $tool"; fi
done <"$stage/needs"
if [ -n "$missing" ]; then note "missing$missing"; exit 127; fi
mkdir -p "$MIRROR/$SUBDIR" && cd "$MIRROR/$SUBDIR" || exit 70
( . "$stage/command" )
code=$?
cd "$MIRROR" || exit 70
while IFS= read -r path || [ -n "$path" ]; do
    safe "$path" || continue
    if [ -e "$path" ] || [ -L "$path" ]; then
        mkdir -p "$stage/out/$(dirname "$path")" && cp -R "$path" "$stage/out/$path"
    else
        note "absent $path"
    fi
done <"$stage/fetch"
exit "$code"
`;

// Windows PowerShell 5.1, which every Windows has. The PATH is read again from what Windows keeps: a toolchain installed
// after the computer's agent started (rustup, in the audit) is on that one and not on the agent's own.
export const RUN_PS1 = `# devices exec, on the computer: the sandbox's bin/devices-exec-scripts.mjs wrote this for one run.
$ErrorActionPreference = 'Continue'
$stage = $PSScriptRoot
. (Join-Path $stage 'vars.ps1')
function Note([string] $text) { [Console]::Out.WriteLine("intentic-mirror: $text") }
function Lines([string] $name) { @(Get-Content -LiteralPath (Join-Path $stage $name) -Encoding UTF8 | Where-Object { $_ -ne '' }) }
function Safe([string] $path) { -not ($path -match '^([\\\\/]|[A-Za-z]:)' -or $path -match '(^|[\\\\/])\\.\\.([\\\\/]|$)') }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
try {
    Get-ChildItem -LiteralPath (Split-Path -Parent $stage) -Directory -Filter '${STAGE_PREFIX}*' | Where-Object { $_.FullName -ne $stage } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $marker = Join-Path $Mirror '.intentic-mirror'
    New-Item -ItemType Directory -Force -Path $marker -ErrorAction Stop | Out-Null
    $generationFile = Join-Path $marker 'generation'
    $have = ''
    if (Test-Path -LiteralPath $generationFile) { $have = [IO.File]::ReadAllText($generationFile).Trim() }
    if ($Expect -ne '' -and $have -ne $Expect) { Note "stale $have"; exit ${STALE_EXIT} }
    foreach ($path in (Lines 'deleted')) {
        $target = Join-Path $Mirror $path
        if ((Safe $path) -and (Test-Path -LiteralPath $target -PathType Leaf)) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
    }
    $delta = Join-Path $stage 'delta.tar'
    if (Test-Path -LiteralPath $delta) {
        & tar.exe -xmf $delta -C $Mirror
        if ($LASTEXITCODE -ne 0) { Note "failed could not unpack the changes into $Mirror"; exit 70 }
        Remove-Item -LiteralPath $delta -Force
    }
    [IO.File]::WriteAllText($generationFile, $Generation)
    Note "synced $Generation $Mirror"
    $missing = @(Lines 'needs' | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -gt 0) { Note "missing $($missing -join ' ')"; exit 127 }
    $work = if ($Subdir -eq '') { $Mirror } else { Join-Path $Mirror $Subdir }
    New-Item -ItemType Directory -Force -Path $work -ErrorAction Stop | Out-Null
    Set-Location -LiteralPath $work
} catch {
    Note "failed could not prepare the mirror: $_"
    exit 70
}
$global:LASTEXITCODE = 0
$code = 0
try {
    & ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $stage 'command'))))
    if ($LASTEXITCODE) { $code = $LASTEXITCODE }
} catch {
    [Console]::Error.WriteLine($_)
    $code = 1
}
Set-Location -LiteralPath $Mirror
foreach ($path in (Lines 'fetch')) {
    if (-not (Safe $path)) { continue }
    if (Test-Path -LiteralPath $path) {
        $into = Join-Path (Join-Path $stage 'out') $path
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $into) | Out-Null
        Copy-Item -LiteralPath $path -Destination $into -Recurse -Force
    } else {
        Note "absent $path"
    }
}
exit $code
`;

const shQuoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuoted = (value) => `'${value.replaceAll("'", "''")}'`;

// Windows PowerShell reads a script with no byte-order mark as the machine's ANSI code page: a mirror under C:\Users\Michał
// would be misread without one.
const BOM = "\uFEFF";

const lines = (values) => (values.length === 0 ? "" : `${values.join("\n")}\n`);

/**
 * The stage folder for one run, written into `dir`: the script for `shell` ("sh" or "powershell") and what it reads.
 * `run` is { mirror, expect, generation, subdir, command, remove, needs, fetch }.
 */
export const stageFiles = (shell, run) => {
    const vars = { MIRROR: run.mirror, EXPECT: run.expect, GENERATION: run.generation, SUBDIR: run.subdir };
    const common = {
        command: `${run.command}\n`,
        deleted: lines(run.remove),
        needs: lines(run.needs),
        fetch: lines(run.fetch),
    };
    if (shell === "powershell") {
        const assigned = Object.entries(vars).map(([name, value]) => `$${name[0]}${name.slice(1).toLowerCase()} = ${psQuoted(value)}`);
        return { ...common, "vars.ps1": `${BOM}${lines(assigned)}`, "run.ps1": `${BOM}${RUN_PS1}` };
    }
    return { ...common, vars: lines(Object.entries(vars).map(([name, value]) => `${name}=${shQuoted(value)}`)), "run.sh": RUN_SH };
};
