#!/usr/bin/env node
// Rehearse the onboarding a Windows user gets from app.intentic.dev, on this PC, from THIS branch: build the
// installer, serve it from the local site, point the machine at the local platform, and hand the flow over to
// a person with the click-path written out. One command, from the checkout, in WSL.
//
//   pnpm try:onboarding                      # build, stage, prepare this PC, open the door, then watch
//   pnpm try:onboarding -- --check           # say what is ready and what this would do, and change nothing
//   pnpm try:onboarding -- --skip-build      # reuse what is already staged (the usual second run)
//   pnpm try:onboarding -- --sandbox-image intentic-sandbox:dev   # test the branch's daemon too
//   pnpm try:onboarding -- --teardown        # put the PC back
//
// WHAT IS SUBSTITUTED, AND NOTHING ELSE IS. The installer, the scheme registration, the app's own screens,
// the bundled connect.ps1, the image pull, the sandbox and the workspace are the shipped path, byte for byte.
// Four things cannot be, and each is a consequence of the platform being local rather than hosted:
//
//   • the app's settings file names the local api and the local SPA. The installed app resolves both from its
//     settings, then its environment, then the hosted defaults (state.rs) — and a setup link arriving from an
//     EXTERNAL browser carries no `platform` of its own, since setup_link.rs drops that parameter unless the
//     link came from the app's own window. A rehearsal that skipped this would mint a code on the local
//     platform and redeem it against the real one.
//   • IC_URL names the local site. connect.ps1 downloads `$IC_URL/ic-windows-amd64.exe` and defaults to the
//     latest GitHub release; a working-tree build carries the 0.0.0 sentinel, so it pins no release of its
//     own (commands.rs `ic_url`) and would otherwise drive the last release's CLI.
//   • the update check is off, so a 0.0.0 build is not offered the last release halfway through.
//   • the installer is downloaded from http://localhost:4321 rather than intentic.dev, which is what the dev
//     SPA's own download links already point at (desktopDownloads.ts).
//
// Everything this does to the PC is recorded and reversed by `--teardown`, including the app that was
// installed before it ran.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "../../constants/src/node.mjs";
import { CA_CRT } from "../../localhost-https/paths.mjs";

const execFileAsync = promisify(execFile);
const root = repoRoot(import.meta.url);

// What Windows lists the app as, where it keeps its settings, and the one version string that means "built
// from a working tree" — the same three facts _tools/desktop-smoke-windows/src/constants.ts states for the
// automated tiers. Duplicated rather than imported because that package is TypeScript that has to be built
// first, and this script must run on a checkout nobody has built yet.
const PRODUCT_NAME = "Intentic";
const APP_IDENTIFIER = "dev.intentic.desktop";
const WORKING_TREE_VERSION = "0.0.0";

// The astro dev server's port, named here because the dev SPA's download links name it too
// (_editor/web/src/app/environments/desktopDownloads.ts) — they have to agree or the button downloads nothing.
const SITE_ORIGIN = "http://localhost:4321";
// What the local site hands out under that origin: the staged installer, and the CLI the setup downloads.
const INSTALLER_FILE = "Intentic-setup.exe";
const IC_FILE = "ic-windows-amd64.exe";
const IC_URL = `${SITE_ORIGIN}/desktop`;

// Machine state, beside the dev CA rather than in the checkout: what was on this PC before is a fact about
// the PC, and a second worktree tearing down with a third one's memory would restore the wrong thing.
const STATE_FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "intentic", "try-onboarding.json");

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--teardown", "--check", "--skip-build", "--sandbox-image", "--keep-app", "--no-open", "--no-watch"]);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};
for (const [at, arg] of args.entries()) {
    // A value is only a value if the token before it took one; anything else that looks like a flag is a typo.
    if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg) && args[at - 1] !== "--sandbox-image") {
        console.error(`try-onboarding: unknown flag ${arg} — see the header of this file`);
        process.exit(2);
    }
}

const say = (line = "") => console.log(line);
const step = (line) => say(`\n\u001b[1m${line}\u001b[0m`);
const ok = (line) => say(`  ok    ${line}`);
const note = (line) => say(`  note  ${line}`);
const bad = (line) => say(`  FAIL  ${line}`);

/** Runs a command and hands back its outcome; a non-zero exit is an answer here, never a throw. */
const sh = async (file, argv, options = {}) => {
    try {
        const { stdout, stderr } = await execFileAsync(file, argv, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
        return { code: 0, stdout, stderr };
    } catch (error) {
        return { code: typeof error.code === "number" ? error.code : 127, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message) };
    }
};

/** Runs a command with the terminal attached, for the builds whose output is the point. */
const shLive = async (file, argv, options = {}) =>
    await new Promise((resolve) => {
        const child = spawn(file, argv, { cwd: root, stdio: "inherit", ...options });
        child.on("close", (code) => resolve(code ?? 1));
    });

const which = async (command) => (await sh("sh", ["-c", `command -v ${command}`])).code === 0;

/* ── the Windows side ─────────────────────────────────────────────────────────────────────────────────── */

// Scripts reach PowerShell as -EncodedCommand (UTF-16LE base64): quoting then stops being a thing that exists
// on the way in, which is the lesson _tools/desktop-smoke-windows/src/run.ts writes down at length — a script
// passed as text negotiates every embedded quote twice, and the failure is a silent empty string.
const powershell = async (script, options = {}) =>
    await sh(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        options,
    );

/** A JS string as a PowerShell single-quoted literal: doubling is the only escape that language has. */
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** `ConvertTo-Json` answers nothing / an object / an array for 0 / 1 / N results; all three are a list. */
const asList = (json) => {
    const text = json.trim();
    if (text === "") {
        return [];
    }
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
};

// Both hives: a currentUser install lands in HKCU, an elevated or per-machine one in HKLM.
const UNINSTALL_KEYS = [
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
];

// Windows' own UninstallString, run through Start-Process -Wait: NSIS returns before its work is done, so a
// direct spawn reports success while the app is still on the machine.
const uninstall = async (installed) =>
    await powershell(
        `$p = Start-Process -FilePath ${psQuote(String(installed.UninstallString).replace(/^"|"$/gu, ""))} -ArgumentList '/S' -Wait -PassThru
         exit $p.ExitCode`,
        { timeout: 10 * 60 * 1000 },
    );

/** What Windows says is installed under this name, or undefined. */
const installedApp = async () => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-ItemProperty ${UNINSTALL_KEYS.map(psQuote).join(",")} |
           Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString |
           ConvertTo-Json -Depth 3 -Compress`,
    );
    return asList(result.stdout).find((entry) => entry?.DisplayName === PRODUCT_NAME);
};

/** The user's own directories and the environment an OS-launched app would inherit today. */
const windowsFacts = async () => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         $facts = @{}
         $facts['appData'] = $env:APPDATA
         $facts['localAppData'] = $env:LOCALAPPDATA
         $facts['userProfile'] = $env:USERPROFILE
         $facts['icUrl'] = [Environment]::GetEnvironmentVariable('IC_URL','User')
         $facts['updateCheck'] = [Environment]::GetEnvironmentVariable('INTENTIC_DISABLE_UPDATE_CHECK','User')
         $facts['sandboxImage'] = [Environment]::GetEnvironmentVariable('INTENTIC_SANDBOX_IMAGE','User')
         $browsers = Get-Process chrome,msedge,firefox,brave,opera,vivaldi,zen -ErrorAction SilentlyContinue |
           Select-Object -ExpandProperty ProcessName -Unique
         $facts['browsers'] = @($browsers) -join ','
         $facts | ConvertTo-Json -Compress`,
    );
    const facts = asList(result.stdout)[0];
    if (facts?.appData === undefined || facts.appData === null) {
        throw new Error(`could not read this PC's environment through powershell.exe:\n${result.stderr || result.stdout}`);
    }
    return facts;
};

// A user environment variable, which is what an app started by Explorer, a browser or the Start menu inherits.
// .NET's setter broadcasts WM_SETTINGCHANGE the way setx does, so a shell started after this call sees it —
// one started BEFORE it does not, which is the gotcha the report below spells out.
const setUserEnv = async (name, value) =>
    await powershell(`[Environment]::SetEnvironmentVariable(${psQuote(name)}, ${value === null ? "$null" : psQuote(value)}, 'User')`);

/* ── the local platform ───────────────────────────────────────────────────────────────────────────────── */

// The dev world is https on loopback under this machine's own CA (_tools/localhost-https), so every probe here
// is handed that root explicitly. Node trusts its own bundle and nothing else, and a rejected certificate
// here would read as "the platform is down" — the exact misdiagnosis the onboarding tier's README warns about.
// The response is dropped the moment its status arrives rather than drained: one of these asks for a 90 MB
// installer, and the question is whether the site serves it, not what is in it.
const status = async (url) =>
    await new Promise((resolve) => {
        const secure = new URL(url).protocol === "https:";
        const send = secure ? httpsRequest : httpRequest;
        const request = send(url, secure ? { ca: readFileSync(CA_CRT) } : {}, (response) => {
            response.destroy();
            resolve(response.statusCode);
        });
        request.on("error", () => resolve(undefined));
        request.setTimeout(4000, () => {
            request.destroy();
            resolve(undefined);
        });
        request.end();
    });

/** Did a server answer at all — which is what "is the platform up" means. */
const reachable = async (url) => {
    const code = await status(url);
    return code !== undefined && code < 500;
};

/** Is this exact URL served — which is a different question, and the one a download button asks. */
const serves = async (url) => (await status(url)) === 200;

/** Root .env as the api reads it: everything after the first `=`, verbatim, comments and all. */
const readEnvFile = (path) => {
    const found = {};
    if (!existsSync(path)) {
        return found;
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0 && !line.trimStart().startsWith("#")) {
            found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
    }
    return found;
};

const env = readEnvFile(join(root, ".env"));
// The two origins the platform boots on; the same defaults .env.example carries, so an unset key is not a stop.
const apiUrl = env.API_URL ?? "https://localhost:6480";
const webOrigin = env.WEB_ORIGIN ?? "https://localhost:47145";

const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined);
const writeState = (state) => {
    mkdirSync(join(STATE_FILE, ".."), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, undefined, 2)}\n`);
};

/* ── preflight ────────────────────────────────────────────────────────────────────────────────────────── */

// Every check here is one whose absence produces a failure that names something else: no interop reads as a
// broken script, an unsigned platform offers only the attach lane and looks like a missing feature, a browser
// that does not trust this machine's CA says "Intentic isn't reachable" and blames the network.
const preflight = async (mode) => {
    const problems = [];
    const require = (condition, remedy) => {
        if (condition) {
            return true;
        }
        problems.push(remedy);
        return false;
    };
    const refuse = () => {
        if (problems.length === 0) {
            return;
        }
        step("this PC is not ready");
        for (const problem of problems) {
            bad(problem);
        }
        say();
        process.exit(1);
    };

    require(process.platform === "linux", "run this from the WSL checkout — it drives the Windows side through interop");
    require(await which("powershell.exe"), "no powershell.exe on PATH: WSL interop is off (enable it in /etc/wsl.conf, then `wsl --shutdown`)");
    // Putting the PC back needs the bridge and nothing else: a teardown refused because Docker is down or the
    // .env lost a key would strand the machine in the rehearsal's shape for the sake of a check it never uses.
    if (mode === "teardown") {
        refuse();
        return;
    }
    require(await which("pnpm"), "pnpm is not on PATH");
    require((await sh("docker", ["info", "--format", "{{.ServerVersion}}"])).code === 0, "no Docker daemon answers: start Docker Desktop");
    require(existsSync(CA_CRT), "no development CA yet: run `pnpm install`, then `pnpm cert:trust`");
    require(existsSync(join(root, ".env")), "no .env at the repo root: copy .env.example and fill in the Google credentials");
    const unsigned =
        "INGRESS_SIGNING_KEY is empty in .env: the platform signs reachability grants, and without a key the setup screen offers " +
        "only the attach lane — no setup code, and nothing for the app to redeem (generate one with " +
        "`openssl genpkey -algorithm ed25519`, quoted in the file so its newlines survive)";
    require((env.INGRESS_SIGNING_KEY ?? "") !== "", unsigned);
    require((env.GOOGLE_CLIENT_ID ?? "") !== "", "GOOGLE_CLIENT_ID is empty in .env: there is no way to sign in to the local platform");
    if (mode === "build") {
        require(await which("cargo"), "cargo is not on PATH: the installer is a Rust cross-build (https://rustup.rs)");
        require(await which("cargo-xwin"), "cargo-xwin is missing: `cargo install --locked cargo-xwin`");
        require((await sh("rustup", ["target", "list", "--installed"])).stdout.includes(
            "x86_64-pc-windows-msvc",
        ), "the MSVC target is not installed: `rustup target add x86_64-pc-windows-msvc`");
        // The tools by the names cargo-xwin and the bundler actually invoke, not the packages carrying them:
        // a distribution that ships clang without the clang-cl alias fails deep inside a link step otherwise.
        // The CI runner installs the Debian equivalents in build-desktop.sh; this only reports.
        for (const [tool, packages] of [
            ["clang-cl", "clang"],
            ["lld-link", "lld"],
            ["llvm-lib", "llvm"],
            ["makensis", "nsis"],
        ]) {
            require(await which(tool), `${tool} is missing: the Windows cross-build needs it (pacman -S ${packages} / apt-get install ${packages})`);
        }
    }
    refuse();
};

/* ── the steps ────────────────────────────────────────────────────────────────────────────────────────── */

const build = async () => {
    step("building this branch's Windows artifacts");
    note("first run compiles the app and the CLI for MSVC; minutes, then cached");
    if ((await shLive("bash", [join(root, "_tools/scripts/build/build-ic.sh"), "windows-x64"])) !== 0) {
        bad("ic did not build — the app's setup downloads that binary, so this is not optional");
        process.exit(1);
    }
    if ((await shLive("bash", [join(root, "_editor/desktop-app/scripts/stage-local-downloads.sh"), "--windows-only"])) !== 0) {
        bad("the installer did not build");
        process.exit(1);
    }
    ok("installer and ic staged into _site/site/public/desktop");
};

// Reused when it is already up, which is the common case: this is a developer's own `pnpm dev`, and a second
// one would die on vite's strict port anyway. Started detached when it is not, since the flow outlives this
// process — the person walking it may take twenty minutes, and the stack has to answer for all of them.
const platform = async (state) => {
    step("the local platform");
    const up = async () => (await reachable(`${apiUrl}/health`)) && (await reachable(webOrigin)) && (await reachable(SITE_ORIGIN));
    if (await up()) {
        ok(`already up: api ${apiUrl}, app ${webOrigin}, site ${SITE_ORIGIN}`);
        return;
    }
    // Beside the state file rather than in the checkout: a log the repo would have to learn to ignore.
    const log = join(STATE_FILE, "..", "dev-stack.log");
    mkdirSync(join(log, ".."), { recursive: true });
    const handle = openSync(log, "a");
    const child = spawn("pnpm", ["dev"], { cwd: root, detached: true, stdio: ["ignore", handle, handle] });
    child.unref();
    state.startedStack = child.pid;
    note(`started \`pnpm dev\` (pid ${child.pid}), logging to ${log}`);
    for (let waited = 0; waited < 300; waited += 3) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (await up()) {
            ok(`up: api ${apiUrl}, app ${webOrigin}, site ${SITE_ORIGIN}`);
            return;
        }
    }
    bad(`the platform did not come up within five minutes — read ${log}`);
    process.exit(1);
};

// Asked of the site rather than the filesystem: what matters is that the browser's download resolves, and a
// staged file the dev server does not serve fails here instead of on the user's screen two steps later.
const downloads = async () => {
    step("what the local site hands out");
    for (const file of [INSTALLER_FILE, IC_FILE]) {
        if (await serves(`${SITE_ORIGIN}/desktop/${file}`)) {
            ok(`${SITE_ORIGIN}/desktop/${file}`);
        } else {
            bad(`${SITE_ORIGIN}/desktop/${file} is not being served — re-run without --skip-build`);
            process.exit(1);
        }
    }
    // The vanity path is what the site's own download page links; when nothing is staged it REDIRECTS to the
    // GitHub releases page, so a 200 here is the difference between the local build and the last release.
    if (await serves(`${SITE_ORIGIN}/desktop/windows`)) {
        ok(`${SITE_ORIGIN}/desktop/windows hands over the same local installer`);
    } else {
        bad(`${SITE_ORIGIN}/desktop/windows is not serving the staged installer — the site would send you to a release`);
        process.exit(1);
    }
};

// A first run is the thing being rehearsed, and an install over an existing one is a different flow with
// different screens. The version that was here is recorded first, so teardown can say what this PC had.
const removeInstalledApp = async (state) => {
    const installed = await installedApp();
    if (installed === undefined) {
        return;
    }
    if (flag("keep-app")) {
        note(`${PRODUCT_NAME} ${installed.DisplayVersion} left installed (--keep-app): the installer will run as an upgrade, not a first install`);
        return;
    }
    // Recorded BEFORE the uninstall, not after: a run that dies between the two must still know what it removed.
    // Never overwritten, because the second rehearsal in a row finds its OWN build here — recording that would
    // teach teardown that this PC's app has always been a working-tree build.
    if (state.previousApp === undefined) {
        state.previousApp = { version: installed.DisplayVersion, uninstallString: installed.UninstallString };
        writeState(state);
    }
    const result = await uninstall(installed);
    if (result.code !== 0) {
        bad(`the installed ${PRODUCT_NAME} ${installed.DisplayVersion} would not uninstall (exit ${result.code}) — close it and re-run`);
        process.exit(1);
    }
    ok(`uninstalled ${PRODUCT_NAME} ${installed.DisplayVersion}, so the install ahead is a first one`);
};

// Aside rather than deleted: sandbox names, the install id this PC's analytics ride on, and the close answer
// the user already gave all live in that directory, and a rehearsal is not a reason to lose them.
const parkAppState = async (state, settingsDir, facts) => {
    if (flag("keep-app")) {
        return;
    }
    // A rehearsal that already parked this PC's state removes what it finds instead: the directory there now is
    // the last rehearsal's, and backing it up would bury the one belonging to the person.
    if (state.appStateBackup !== undefined) {
        await powershell(`Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${psQuote(settingsDir)}`);
        ok(`the last rehearsal's app state is cleared; yours is still parked at ${state.appStateBackup}`);
        return;
    }
    const backup = `${facts.localAppData}\\Temp\\intentic-try-onboarding\\${Date.now()}`;
    const moved = await powershell(
        `$ErrorActionPreference='Stop'
         if (Test-Path ${psQuote(settingsDir)}) {
           New-Item -ItemType Directory -Force -Path ${psQuote(backup)} | Out-Null
           Move-Item -Force ${psQuote(settingsDir)} ${psQuote(`${backup}\\${APP_IDENTIFIER}`)}
           Write-Output 'moved'
         }`,
    );
    if (moved.stdout.trim() === "moved") {
        state.appStateBackup = `${backup}\\${APP_IDENTIFIER}`;
        writeState(state);
        ok(`this PC's app state moved aside to ${state.appStateBackup}`);
    }
};

const prepare = async (state, facts) => {
    step("pointing this PC at the local platform");
    const settingsDir = `${facts.appData}\\${APP_IDENTIFIER}`;
    await removeInstalledApp(state);
    await parkAppState(state, settingsDir, facts);

    const settings = JSON.stringify({ appUrl: webOrigin, platformUrl: apiUrl }, undefined, 2);
    await powershell(
        `$ErrorActionPreference='Stop'
         New-Item -ItemType Directory -Force -Path ${psQuote(settingsDir)} | Out-Null
         Set-Content -Path ${psQuote(`${settingsDir}\\settings.json`)} -Encoding utf8 -Value @'
${settings}
'@`,
    );
    state.settingsFile = `${settingsDir}\\settings.json`;
    ok(`the app will open ${webOrigin} and redeem its setup code against ${apiUrl}`);

    // Also never overwritten: what these were before the FIRST rehearsal is what teardown owes this PC back.
    state.previousEnv ??= {
        IC_URL: facts.icUrl ?? null,
        INTENTIC_DISABLE_UPDATE_CHECK: facts.updateCheck ?? null,
        INTENTIC_SANDBOX_IMAGE: facts.sandboxImage ?? null,
    };
    await setUserEnv("IC_URL", IC_URL);
    ok(`IC_URL=${IC_URL}, so the setup downloads this branch's ic rather than the last release's`);
    await setUserEnv("INTENTIC_DISABLE_UPDATE_CHECK", "1");
    ok("the app's update check is off for the rehearsal");
    const image = option("sandbox-image");
    await setUserEnv("INTENTIC_SANDBOX_IMAGE", image ?? null);
    ok(
        image === undefined
            ? "the sandbox image is the shipped default (ghcr.io/intentic/sandbox:stable), as a real install would pull"
            : `the setup will run ${image} (--sandbox-image)`,
    );
};

/* ── what to do now ───────────────────────────────────────────────────────────────────────────────────── */

const report = async (facts) => {
    const head = (await sh("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    step("walk it");
    say(`  1.  ${webOrigin} is open in your browser — sign in with Google, as a new user would.`);
    say(`  2.  The setup card leads with "Download for Windows", which is ${SITE_ORIGIN}/desktop/${INSTALLER_FILE}:`);
    say(`      the installer ${flag("skip-build") ? "staged here" : `built from ${head}`} minutes ago.`);
    say(`  3.  Run it. Windows warns about an unknown publisher — a release is signed, a local build is not.`);
    say(`  4.  The app opens a window of its own on ${webOrigin}. That webview has its own cookies, so it asks`);
    say(`      you to sign in again and sends you through the browser to do it (Google refuses a webview).`);
    say(`  5.  On the card inside the app, "Set it up now" hands the code over intentic://setup, and the app runs`);
    say(`      the shipped connect.ps1: fetch ic, check Docker, redeem the code, pull the image, start the`);
    say(`      sandbox, wait for health. Then the workspace opens.`);
    say();
    say(`  Site door, if you want the landing page instead: ${SITE_ORIGIN}/download/`);
    say(`  When a step fails, the run's own transcript is the first thing to read:`);
    say(`  ${facts.userProfile}\\.intentic\\logs\\desktop-setup-<stamp>.log`);

    step("two ways this rehearsal lies, and how to avoid them");
    const browsers = String(facts.browsers ?? "").trim();
    if (browsers !== "") {
        say(`  • ${browsers} was already running when this command set IC_URL. A process inherits its environment at`);
        say(`    start, so an app launched from that browser will not see it — close those windows and reopen one,`);
        say(`    or quit the app from the tray and start it from the Start menu once it is installed.`);
    } else {
        say(`  • Open the browser only from here. A process started before this command inherits the old environment,`);
        say(`    and an app launched from it downloads the last release's ic instead of this branch's.`);
    }
    say(`  • This is a 0.0.0 build: it is unsigned, it names no release, and its updater is off. Nothing about`);
    say(`    SmartScreen, code signing or the update path is being tested here.`);

    step("when you are done");
    say(`  pnpm try:onboarding -- --teardown    # uninstalls this build, restores your app state and environment`);
    say();
};

/** Sandbox containers, all of them or only the running ones — one Docker serves this whole PC. */
const sandboxContainers = async (includeStopped) => {
    const argv = ["ps", ...(includeStopped ? ["-a"] : []), "--format", "{{.Names}}\t{{.Ports}}", "--filter", "name=intentic-sandbox-"];
    return (await sh("docker", argv)).stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => ({ name: line.split("\t")[0], ports: line.split("\t")[1] ?? "" }));
};

// The milestones, as this PC reaches them: the installer only gets to report through the app's own screen, so
// a terminal that says nothing for ten minutes is indistinguishable from one that missed the install.
const watch = async (before) => {
    step("watching (ctrl-c to stop; nothing is torn down by stopping)");
    const seen = new Set();
    const mark = (key, line) => {
        if (!seen.has(key)) {
            seen.add(key);
            ok(`${new Date().toLocaleTimeString()}  ${line}`);
        }
    };
    for (;;) {
        const installed = await installedApp();
        if (installed !== undefined) {
            mark("installed", `${PRODUCT_NAME} ${installed.DisplayVersion} is installed at ${installed.InstallLocation}`);
        }
        for (const container of await sandboxContainers(false)) {
            if (!before.has(container.name)) {
                mark(container.name, `sandbox container ${container.name} is up (${container.ports})`);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
};

const checkPc = async (facts) => {
    step("this PC");
    const installed = await installedApp();
    note(
        installed === undefined
            ? `no ${PRODUCT_NAME} is installed: the install ahead is a first one`
            : `${PRODUCT_NAME} ${installed.DisplayVersion} is installed — a run would uninstall it and park its app state (--keep-app leaves it)`,
    );
    for (const [name, value] of [
        ["IC_URL", facts.icUrl],
        ["INTENTIC_DISABLE_UPDATE_CHECK", facts.updateCheck],
        ["INTENTIC_SANDBOX_IMAGE", facts.sandboxImage],
    ]) {
        note(`${name} is ${value === null || value === undefined ? "unset" : value}`);
    }
    const browsers = String(facts.browsers ?? "").trim();
    if (browsers !== "") {
        note(`${browsers} is running: start the flow from a browser opened AFTER the run, or it inherits today's environment`);
    }
    const earlier = readState();
    note(earlier === undefined ? "no rehearsal is outstanding" : `a rehearsal from ${earlier.startedAt} was never torn down`);
};

// Reads the same things the run acts on, and acts on none of them. Worth its own mode because every
// requirement here is on a machine rather than in the repo, so "will this work tonight" is a question with
// an answer nobody can give from the checkout.
const check = async (facts) => {
    step("the local platform");
    for (const url of [`${apiUrl}/health`, webOrigin, SITE_ORIGIN]) {
        if (await reachable(url)) {
            ok(`${url} answers`);
        } else {
            note(`${url} is not answering — a run would start \`pnpm dev\` and wait for it`);
        }
    }

    step("what the local site hands out");
    for (const file of [INSTALLER_FILE, IC_FILE]) {
        if (await serves(`${SITE_ORIGIN}/desktop/${file}`)) {
            ok(`${SITE_ORIGIN}/desktop/${file}`);
        } else {
            note(`${SITE_ORIGIN}/desktop/${file} is not staged — a run would build it`);
        }
    }

    await checkPc(facts);
    say();
};

/* ── teardown ─────────────────────────────────────────────────────────────────────────────────────────── */

// Only a working-tree build is removed. A release reinstalled since this ran is somebody's actual app, and
// uninstalling it because the name matches would be this script deciding what the PC is for.
const removeRehearsalBuild = async () => {
    const installed = await installedApp();
    if (installed === undefined) {
        return;
    }
    if (installed.DisplayVersion !== WORKING_TREE_VERSION) {
        note(`${PRODUCT_NAME} ${installed.DisplayVersion} is installed and is not this rehearsal's build — left alone`);
        return;
    }
    await uninstall(installed);
    ok(`the ${WORKING_TREE_VERSION} build is uninstalled`);
};

const restoreAppState = async (state) => {
    if (state.settingsFile !== undefined) {
        await powershell(`Remove-Item -Force -ErrorAction SilentlyContinue ${psQuote(state.settingsFile)}`);
        ok("the settings file pointing at the local platform is gone");
    }
    if (state.appStateBackup === undefined) {
        return;
    }
    const settingsDir = `${(await windowsFacts()).appData}\\${APP_IDENTIFIER}`;
    await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Remove-Item -Recurse -Force ${psQuote(settingsDir)}
         Move-Item -Force ${psQuote(state.appStateBackup)} ${psQuote(settingsDir)}`,
    );
    ok(`your app state is back at ${settingsDir}`);
};

// What a teardown deliberately does not undo, said rather than left to be found. The sandbox a rehearsal
// brought up holds real work from the moment somebody typed into it, and it sits on the same Docker as every
// other sandbox on this PC — so it is named, never removed.
const reportLeftovers = async (state) => {
    if (state.previousApp !== undefined) {
        note(`this PC had ${PRODUCT_NAME} ${state.previousApp.version} before the rehearsal — reinstall it from https://intentic.dev/download/`);
    }
    // A run that died before it listed them knows nothing about which container is whose, and naming every
    // sandbox on the PC as this rehearsal's leaving would be worse than saying nothing.
    if (state.sandboxesBefore === undefined) {
        return;
    }
    const known = new Set(state.sandboxesBefore);
    for (const container of await sandboxContainers(true)) {
        if (!known.has(container.name)) {
            note(`the rehearsal left ${container.name} — \`docker rm -f ${container.name}\` when you are done with it`);
        }
    }
};

const teardown = async () => {
    const state = readState();
    if (state === undefined) {
        step("nothing to put back");
        note(`no record at ${STATE_FILE} — this PC was never prepared, or a teardown already ran`);
        return;
    }
    step("putting this PC back");

    for (const [name, value] of Object.entries(state.previousEnv ?? {})) {
        await setUserEnv(name, value);
        ok(value === null ? `${name} unset` : `${name} restored to ${value}`);
    }

    // Only a working-tree build is removed. A release reinstalled since this ran is somebody's actual app, and
    // uninstalling it because the name matches would be this script deciding what the PC is for.
    await removeRehearsalBuild();
    await restoreAppState(state);
    await reportLeftovers(state);
    if (state.startedStack !== undefined) {
        try {
            // The process group, because `pnpm dev` is turbo plus three servers and killing the parent orphans them.
            process.kill(-state.startedStack, "SIGTERM");
            ok(`the \`pnpm dev\` this rehearsal started (pid ${state.startedStack}) is stopped`);
        } catch {
            // Already gone, or someone else's pid by now — either way there is nothing here to stop.
            note(`the \`pnpm dev\` this rehearsal started (pid ${state.startedStack}) is no longer running`);
        }
    }

    rmSync(STATE_FILE, { force: true });
    say();
};

/* ── the run ──────────────────────────────────────────────────────────────────────────────────────────── */

if (flag("teardown")) {
    await preflight("teardown");
    await teardown();
    process.exit(0);
}

await preflight(flag("skip-build") ? "run" : "build");

if (flag("check")) {
    await check(await windowsFacts());
    process.exit(0);
}

// A rehearsal that was never torn down hands its memory to this one: what this PC looked like before the
// FIRST of them is the only state teardown can honestly restore, and re-reading the machine now would read
// the last rehearsal's own leavings as the way the PC has always been.
const earlier = readState();
const state = {
    startedAt: new Date().toISOString(),
    webOrigin,
    apiUrl,
    ...(earlier === undefined
        ? {}
        : {
              previousApp: earlier.previousApp,
              appStateBackup: earlier.appStateBackup,
              previousEnv: earlier.previousEnv,
              startedStack: earlier.startedStack,
          }),
};
const facts = await windowsFacts();
// Written before the first change and after every one: a run that dies halfway must still be undoable.
writeState(state);
if (earlier !== undefined) {
    note(`picking up a rehearsal from ${earlier.startedAt} that was never torn down — this PC's own state is still parked`);
}

if (!flag("skip-build")) {
    await build();
}
await platform(state);
writeState(state);
await downloads();
await prepare(state, facts);
writeState(state);

// Recorded, not just held: the sandbox this rehearsal creates is a real one on a Docker shared with every
// other sandbox on this PC, so teardown has to be able to say which container is the new one rather than
// deciding for itself what a name starting with the prefix is for.
const before = new Set((await sandboxContainers(true)).map((container) => container.name));
state.sandboxesBefore = [...before];
writeState(state);

if (!flag("no-open")) {
    await powershell(`Start-Process ${psQuote(webOrigin)}`);
}
await report(facts);

if (!flag("no-watch")) {
    await watch(before);
}
