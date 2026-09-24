import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Refuses module-level reactive state in the editor unless it is declared through the sandbox scope (sandboxRef,
// sandboxShallowRef, sandboxValue from @intentic/extension-api, reset on every switch) or named below as app-wide.
// Found by shape over every module under src/, the way extension-host/sandboxScope.guard.test.ts reads the extensions:
// a .ts whole, a .vue's plain <script> only, since <script setup> runs per component instance and dies with it.

const SRC = import.meta.dirname;

// A component's plain <script> blocks: code that runs once, at module level, beside its per-instance <script setup>.
const PLAIN_SCRIPT = /<script(?![^>]*\bsetup\b)[^>]*>([\s\S]*?)<\/script>/g;
const isModule = (name: string): boolean => name.endsWith(`.vue`) || (name.endsWith(`.ts`) && !name.endsWith(`.test.ts`) && !name.endsWith(`.d.ts`));
const moduleCodeOf = (name: string, text: string): string =>
    name.endsWith(`.vue`) ? [...text.matchAll(PLAIN_SCRIPT)].map((match) => match[1] ?? ``).join(`\n`) : text;

// Every non-test module under src/, as a path relative to it; `testing/` holds the fakes suites share.
const sources = (): { path: string; text: string }[] => {
    const found: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== join(SRC, `testing`)) {
                    walk(full);
                }
                continue;
            }
            if (isModule(entry.name)) {
                found.push({ path: relative(SRC, full).replaceAll(`\\`, `/`), text: moduleCodeOf(entry.name, readFileSync(full, `utf8`)) });
            }
        }
    };
    walk(SRC);
    return found;
};

// Set near the true count so a scan that silently shrinks fails loud, not passes green.
const MIN_SCANNED = 900;

// Column 0 only: the same call indented is inside a function or setup, created per caller, not once. The declaration
// may carry a type with arrows in it (`Ref<() => void>`), so the `=` is the one right before the call.
const MODULE_LEVEL_REACTIVE = /^(?:export )?(?:const|let)\s+(\w+)\b[^\n]*?=\s*(ref|shallowRef|reactive|shallowReactive)\s*[(<]/gm;

// Reasons shared by several entries below.
const GESTURE = `one pointer gesture, which its own pointerup ends; nothing of it outlives the drag`;
const ENTRY_DRAG = `one pointer gesture, ended by its release, its Escape, or a switch (its paths are the sandbox's, and scoped)`;
const EXTENSION_HOST = `the extension host's load record, retired with the activations on a switch and on a relocale (retireExtensions)`;
const REGISTRATION = `registrations an extension or a surface made, retired by whoever registered them`;
const EVENT = `an event counter a mounted surface watches; setting it back would itself be an event`;
const DOCK = `a DOM slot a mounted surface publishes for a panel to teleport into`;
const WINDOW = `which window draws which panel: identity of this window, not of a sandbox`;
const GOOGLE = `the Google credential, which the platform and every daemon accept alike`;
const PREFERENCE = `a preference persisted per browser, the same whichever sandbox is open`;

// State that is not about one sandbox, keyed by the exact string a failing test prints, each with the reason it stays
// plain. Anything about one sandbox belongs in the scope instead; a stale entry fails the last test below.
const APP_WIDE = new Map<string, string>([
    [`app/appUpdate.ts: available = ref(…)`, `a newer build of this app`],
    [`app/appUpdate.ts: dismissed = ref(…)`, `which newer build the reader waved away`],
    [`app/environments/scriptCommand.ts: scriptSource = ref(…)`, `how this developer runs scripts: a choice about the person`],
    [`app/useAudience.ts: chosen = ref(…)`, `whether this browser answered the audience question, asked once per browser`],
    [`core-views/documentRegistry.ts: providers = shallowRef(…)`, REGISTRATION],
    [`core-views/registry.ts: contributed = shallowRef(…)`, REGISTRATION],
    [`core-views/viewerRegistry.ts: viewers = shallowRef(…)`, REGISTRATION],
    [`extension-host/loader.ts: extensionStatuses = shallowRef(…)`, EXTENSION_HOST],
    [`extension-host/loader.ts: loadedCommits = shallowRef(…)`, EXTENSION_HOST],
    [`extension-host/loader.ts: extensionsLoaded = shallowRef(…)`, EXTENSION_HOST],
    [`features/agents/board/columnWidth.ts: railWidth = ref(…)`, `a column width, layout`],
    [`features/agents/board/useAgentDrag.ts: draggedId = ref(…)`, GESTURE],
    [`features/agents/board/useAgentDrag.ts: draggedBox = ref(…)`, GESTURE],
    [`features/agents/board/useAgentDrag.ts: dragging = ref(…)`, GESTURE],
    [`features/agents/board/useAgentDrag.ts: pointer = ref(…)`, GESTURE],
    [`features/agents/board/useAgentDrag.ts: over = ref(…)`, GESTURE],
    [`features/agents/board/useAgentDrag.ts: ghostWidth = ref(…)`, GESTURE],
    [`features/agents/board/useAgentFilter.ts: matchCase = ref(…)`, PREFERENCE],
    [`features/agents/fleet/synthesizeSessions.ts: synthesizing = ref(…)`, `the reentrancy guard of one press, cleared by that press's own finally`],
    [`features/agents/fleet/useAgents-archive.ts: archivedFlash = ref(…)`, EVENT],
    [`features/auth/useAuth.ts: user = ref(…)`, `the signed-in account, above every sandbox`],
    [`features/auth/useGoogleIdentity.ts: needsSignIn = ref(…)`, GOOGLE],
    [`features/auth/useGoogleIdentity.ts: signedInEmail = ref(…)`, GOOGLE],
    [
        `features/chat/drafts/audioWave.ts: waves = shallowRef(…)`,
        `a decode cache keyed by uuid-scoped attachment paths, which no two sandboxes share`,
    ],
    [`features/chat/panel/chatPanelLayout.ts: chatBarPeek = ref(…)`, `a pointer asking to read the strip's turns, layout`],
    [
        `features/chat/session/limitReset.ts: answers = ref(…)`,
        `the provider's answer per account id, a uuid no two sandboxes share; asked once per page, since the endpoint rate-limits hard`,
    ],
    [`features/chat/tabs/useChat-tabs.ts: composerFocus = ref(…)`, EVENT],
    [`features/chat/tabs/useChat-tabs.ts: tabReveal = ref(…)`, EVENT],
    [`features/sandbox/client/useSandbox.ts: sandboxes = ref(…)`, `the account's sandbox list, which a switch chooses from`],
    [
        `features/sandbox/client/useSandbox.ts: connection = ref(…)`,
        `the connection machine, which crosses a switch through its own \`switched\` signal`,
    ],
    [`features/sandbox/client/useSandbox.ts: wakeRefused = ref(…)`, `a refused wake, stamped with the sandbox it names`],
    [
        `features/sandbox/devices/loopback/localShortcut.ts: allowed = ref(…)`,
        `this browser's yes to local-network access, kept per browser like the permission`,
    ],
    [`features/sandbox/devices/loopback/localShortcut.ts: declined = ref(…)`, `the sandboxes that said no, keyed by sandbox id`],
    [`features/sandbox/devices/loopback/localShortcut.ts: asking = ref(…)`, `the one open local-network question, naming its sandbox`],
    [
        `features/sandbox/live/sandboxRestart.ts: carried = shallowRef(…)`,
        `the restart ledger, each record naming its sandbox; it outlives the page on purpose`,
    ],
    [
        `features/sandbox/live/sandboxRestart.ts: claims = shallowRef(…)`,
        `the restart ledger, each record naming its sandbox; it outlives the page on purpose`,
    ],
    [`features/sandbox/overview/activeSandbox.ts: activeSandboxId = ref(…)`, `the scope's own key: what a switch changes`],
    [
        `features/sandbox/overview/contractFreshness.ts: uncompiled = ref(…)`,
        `the dev server's compiled contract against source, a fact about this build`,
    ],
    [`features/sandbox/secrets/useEndpoint.ts: endpoints = ref(…)`, `the resolved endpoint per sandbox id, one entry per sandbox`],
    [`features/sandbox/session/sandboxSession.ts: sessions = ref(…)`, `daemon sessions keyed by sandbox id`],
    [`features/sandbox/session/signInPrompt.ts: prompt = shallowRef(…)`, `the one sign-in question, naming the daemon it is for`],
    [`features/setup/desktopSetup.ts: report = ref(…)`, `the desktop app's own setup report`],
    [`features/setup/desktopSetup.ts: heardAt = ref(…)`, `when that report was last heard`],
    [`features/workspace/changes/changesAcross.ts: pushing = ref(…)`, `the cross-sandbox ledger's one push, keyed by the box it runs on`],
    [`features/workspace/changes/changesAcross.ts: pushError = ref(…)`, `why a ledger push was refused, keyed by its row like the push itself`],
    [`features/workspace/explorer/transfer/useEntryDrag.ts: dragging = ref(…)`, ENTRY_DRAG],
    [`features/workspace/explorer/transfer/useEntryDrag.ts: pointer = ref(…)`, ENTRY_DRAG],
    [`features/workspace/explorer/transfer/useEntryDrag.ts: over = ref(…)`, ENTRY_DRAG],
    [`features/workspace/files/upload/useUploadQueue.ts: installAfterUpload = ref(…)`, PREFERENCE],
    [`features/workspace/search/searchSnippet.ts: tokenVersion = ref(…)`, `bumped when the highlighter's tokens load, a fact about this page`],
    [`features/workspace/tabs/useWorkspaceTabs.ts: splitAllowed = ref(…)`, `whether the layout has room for two panes, set by the surface`],
    [`shell/commands/useCommands.ts: commands = shallowRef(…)`, REGISTRATION],
    [`shell/commands/useQuickOpen.ts: isOpen = ref(…)`, `whether the palette is open`],
    [`shell/commands/useQuickOpen.ts: mode = ref(…)`, `which chord opened the palette`],
    [
        `shell/hub/hubWork.ts: runs = shallowRef(…)`,
        `work in flight behind a hub row, each run stamped with the sandbox it began on and retired by its own end`,
    ],
    [`shell/notifications/notifications.ts: sources = shallowReactive(…)`, `the app's one notification lane`],
    [`shell/notifications/notifications.ts: receipt = ref(…)`, `the app's one notification lane`],
    [`shell/rail/railPins.ts: writes = shallowRef(…)`, `a counter invalidating reads of the stored pins`],
    [`shell/window/dockSlots.ts: chatDock = shallowRef(…)`, DOCK],
    [`shell/window/dockSlots.ts: chatFullDock = shallowRef(…)`, DOCK],
    [`shell/window/dockSlots.ts: chatBarDock = shallowRef(…)`, DOCK],
    [`shell/window/dockSlots.ts: previewDock = shallowRef(…)`, DOCK],
    [`shell/window/dockSlots.ts: terminalDock = shallowRef(…)`, DOCK],
    [`shell/window/floating.ts: elsewhere = shallowRef(…)`, WINDOW],
    [`shell/window/floating.ts: own = shallowRef(…)`, WINDOW],
    [`shell/window/onScreen.ts: visible = ref(…)`, `this window's own visibility`],
]);

const scanned = sources();
const findings = scanned.flatMap(({ path, text }) =>
    [...text.matchAll(MODULE_LEVEL_REACTIVE)].map((match) => `${path}: ${match[1]} = ${match[2]}(…)`),
);

test(`the guard is actually looking at the editor`, () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
});

// A failure names state one sandbox fills that the next would inherit: declare it with sandboxRef(() => …) (or
// sandboxShallowRef/sandboxValue), with a dispose for whatever a switch must also end. If it genuinely belongs to the
// app rather than a sandbox, name it in APP_WIDE with the reason.
test(`module-level reactive state is declared through the sandbox scope, or named app-wide`, () => {
    expect(findings.filter((finding) => !APP_WIDE.has(finding))).toEqual([]);
});

// An entry whose state was scoped, renamed or deleted would go on exempting nothing, and exempt its successor by name.
test(`every app-wide entry still names state that exists`, () => {
    expect([...APP_WIDE.keys()].filter((entry) => !findings.includes(entry))).toEqual([]);
});
