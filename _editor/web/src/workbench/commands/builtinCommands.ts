import type { Disposable } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { desktopApp } from "../../app/environments/desktop";
import { useVocabulary } from "../views/vocabulary";
import { ACCOUNT, AGENTS, BROWSERS, CHAT, GO_TO, SANDBOX, SIDE_PANEL, TERMINAL, WORKSPACE } from "./categories";
import { type CommandRegistration, commands, registerCommand } from "./useCommands";

// EVERY BUILT-IN COMMAND WITH A FIXED ID, declared once: its name, family, glyph, default chord and the condition that
// gates that chord. The component that can run one binds a handler to it by id (registerBuiltin) while it is mounted;
// the Keyboard settings page lists this table whole, so the keymap a person edits never depends on which window they
// opened Settings in or which panels happen to be on screen (until 2026-10-21 it listed only the live registry, and a
// desktop window on a folder of this computer, which mounts none of the sandbox shell's panels, showed two rows).
// Commands derived from live state (a destination per extension view, one per repository) are not here: they have no
// fixed id to declare, and stay the registry's alone.

export interface CommandDeclaration {
    /** Read when drawn, so a language switch reaches it. */
    readonly title: () => string;
    readonly category?: string;
    readonly icon?: string;
    readonly keybinding?: string;
    readonly when?: string;
    /** Where the command exists at all, when that is not everywhere; the Keyboard page leaves it off elsewhere. */
    readonly offered?: () => boolean;
}

const onSurface = (surface: string): string => `tabSurface == '${surface}'`;
const REVIEW_WHEN = `agentReviewOnScreen && !editableTarget`;

// Alt+1…9, one per place in the sandbox switcher's list (useSwitchCommands.ts); the live row names the sandbox there.
const switchSlot = (slot: number): CommandDeclaration => ({
    title: () => t(`sandbox.sandboxSwitcher.switchToSlot`, { slot }),
    category: SANDBOX,
    icon: `server`,
    keybinding: `Alt+${slot}`,
});

export const BUILTIN_COMMANDS = {
    "view.home": { title: () => t(`home.open`), category: GO_TO, icon: `th-large`, keybinding: `Mod+Alt+H` },
    // The shell (useShellCommands.ts, ShellDesktop.vue).
    "workspace.goToAnything": { title: () => t(`shell.useShellCommands.anything`), category: GO_TO, icon: `search`, keybinding: `Mod+P` },
    // The one command with no family: it is the list the others are read from.
    "workspace.commandPalette": { title: () => t(`shell.useShellCommands.commandPalette`), icon: `search`, keybinding: `Mod+Shift+P` },
    "terminal.toggle": { title: () => t(`shell.useShellCommands.togglePanel`), category: TERMINAL, icon: `code`, keybinding: `Ctrl+\`` },
    // Matches the physical key globally so terminal.new works while its panel is closed.
    "terminal.new": { title: () => t(`shell.words.new`), category: TERMINAL, icon: `code`, keybinding: `Ctrl+Shift+\`` },
    // The three window toggles say which way a press goes; their live titles follow the state, these name the toggle.
    // Gated off the terminal, where F9 belongs to whatever's there.
    "chat.toggleFloating": {
        title: () => t(`shell.useShellCommands.moveIntoNewWindow`),
        category: CHAT,
        icon: `external-link`,
        keybinding: `F9`,
        when: `tabSurface != 'terminal'`,
    },
    // `layout-left`, not `expand`: the rail is a left-edge dock, not something this command maximises. Unbound: F9 is spent.
    "chat.toggleHome": { title: () => t(`shell.useShellCommands.dockToRail`), category: CHAT, icon: `layout-left` },
    "terminal.toggleFloating": { title: () => t(`shell.useShellCommands.moveIntoNewWindow`), category: TERMINAL, icon: `external-link` },
    "browsers.toggleFloating": { title: () => t(`shell.useShellCommands.moveIntoNewWindow`), category: BROWSERS, icon: `external-link` },
    "view.previousSection": { title: () => t(`shell.shellDesktop.previousRailSection`), category: GO_TO, icon: `chevron-up`, keybinding: `Alt+ArrowUp` },
    "view.nextSection": { title: () => t(`shell.shellDesktop.nextRailSection`), category: GO_TO, icon: `chevron-down`, keybinding: `Alt+ArrowDown` },

    // The account menu (AccountPanel.vue).
    "account.signOut": { title: () => t(`shell.accountPanel.signOut2`), category: ACCOUNT, icon: `sign-out` },
    "account.joinCommunity": { title: () => t(`community.command`), category: ACCOUNT, icon: `discord` },

    // The sandbox switcher (useSwitchCommands.ts); Alt+0 is this computer, inside the desktop app.
    "sandbox.switch1": switchSlot(1),
    "sandbox.switch2": switchSlot(2),
    "sandbox.switch3": switchSlot(3),
    "sandbox.switch4": switchSlot(4),
    "sandbox.switch5": switchSlot(5),
    "sandbox.switch6": switchSlot(6),
    "sandbox.switch7": switchSlot(7),
    "sandbox.switch8": switchSlot(8),
    "sandbox.switch9": switchSlot(9),
    "sandbox.thisComputer": {
        title: () => t(`sandbox.sandboxSwitcher.switchToThisComputer`),
        category: SANDBOX,
        icon: `desktop`,
        keybinding: `Alt+0`,
        offered: () => desktopApp() !== undefined,
    },

    // The side panel's tabs (SidePanel.vue).
    "side.nextTab": { title: () => t(`ui.action.next`), category: SIDE_PANEL, keybinding: `Alt+PageDown`, when: onSurface(`side`) },
    "side.previousTab": { title: () => t(`shell.sidePanel.previous`), category: SIDE_PANEL, keybinding: `Alt+PageUp`, when: onSurface(`side`) },
    "side.closeTab": { title: () => t(`ui.action.close`), category: SIDE_PANEL, icon: `times`, keybinding: `Ctrl+Shift+X`, when: onSurface(`side`) },
    "side.closeOtherTabs": { title: () => t(`shell.sidePanel.closeOthers`), category: SIDE_PANEL, icon: `times`, keybinding: `Ctrl+Shift+,`, when: onSurface(`side`) },
    "side.closeAllTabs": { title: () => t(`shell.sidePanel.closeAll`), category: SIDE_PANEL, icon: `times`, keybinding: `Ctrl+Shift+Backspace`, when: onSurface(`side`) },
    "side.keepTab": { title: () => t(`ui.action.keepOpen`), category: SIDE_PANEL, icon: `pin` },
    "side.openInSection": { title: () => t(`shell.sidePanel.openInSection`), category: SIDE_PANEL, icon: `expand` },
    "side.toggleSplit": { title: () => t(`shell.sidePanel.toggleSplit`), category: SIDE_PANEL, icon: `split-columns`, when: onSurface(`side`) },

    // The chat's tabs (ChatTabs.vue). Close Finished, Pin, Archive, Reopen, Close Pane and Switch are unbound: no file-tab
    // twin, and no chord left free for them; the palette and this page reach them.
    "chat.rename": { title: () => t(`ui.action.renameEllipsis`), category: CHAT, icon: `pencil`, keybinding: `F2`, when: onSurface(`chat`) },
    "chat.closeTab": { title: () => t(`ui.action.close`), category: CHAT, icon: `times`, keybinding: `Ctrl+Shift+X`, when: onSurface(`chat`) },
    "chat.closeOtherTabs": { title: () => t(`chat.words.closeOthers`), category: CHAT, icon: `times`, keybinding: `Ctrl+Shift+,`, when: onSurface(`chat`) },
    "chat.closeTabsToRight": { title: () => t(`ui.action.closeToRight`), category: CHAT, icon: `times`, keybinding: `Ctrl+Shift+.`, when: onSurface(`chat`) },
    "chat.closeFinishedTabs": { title: () => t(`chat.words.closeFinished`), category: CHAT, icon: `times`, when: onSurface(`chat`) },
    "chat.closeAllTabs": { title: () => t(`chat.words.closeAll`), category: CHAT, icon: `times`, keybinding: `Ctrl+Shift+Backspace`, when: onSurface(`chat`) },
    "chat.togglePin": { title: () => t(`chat.chatTabs.togglePin`), category: CHAT, icon: `pin`, when: onSurface(`chat`) },
    "chat.archive": { title: () => t(`chat.chatTabs.archiveChat`), category: CHAT, icon: `box`, when: onSurface(`chat`) },
    "chat.reopenClosed": { title: () => t(`chat.words.reopenClosedChat`), category: CHAT, icon: `history`, when: onSurface(`chat`) },
    "chat.nextNeedsYou": { title: () => t(`chat.chatTabs.nextNeedsYou`), category: CHAT, icon: `exclamation-circle` },
    "chat.nextTab": { title: () => t(`ui.action.next`), category: CHAT, keybinding: `Alt+PageDown`, when: onSurface(`chat`) },
    "chat.previousTab": { title: () => t(`chat.chatTabs.previous`), category: CHAT, keybinding: `Alt+PageUp`, when: onSurface(`chat`) },
    // VSCode's split chord for a different chat, not a second view: a chat carries its own composer.
    "chat.splitView": { title: () => t(`chat.chatTabs.openNextBeside`), category: CHAT, keybinding: `Mod+\\`, when: onSurface(`chat`) },
    "chat.closePane": { title: () => t(`chat.words.closePane`), category: CHAT, when: onSurface(`chat`) },
    "chat.switchTab": { title: () => t(`chat.chatTabs.switch`), category: CHAT, icon: `comments`, when: onSurface(`chat`) },

    // The workspace (WorkspaceDesktop.vue).
    "workspace.search": { title: () => t(`workspace.workspaceDesktop.search`), category: WORKSPACE, icon: `search` },
    "workspace.searchContent": { title: () => t(`workspace.workspaceDesktop.searchInFiles2`), category: WORKSPACE, icon: `search`, keybinding: `Mod+Shift+F` },
    "workspace.showChanges": { title: () => t(`workspace.workspaceDesktop.showChanges`), category: WORKSPACE, icon: `check-square`, keybinding: `Ctrl+Shift+D` },
    "workspace.showFiles": { title: () => t(`workspace.workspaceDesktop.showFiles`), category: WORKSPACE, icon: `folder` },
    "workspace.showHistory": {
        title: () => t(`workspace.workspaceDesktop.show`, { restorePoints: useVocabulary().value.restorePoints }),
        category: WORKSPACE,
        icon: `history`,
    },
    // The root repo's health report: the palette route to what a nested repo opens from its own tree row.
    "workspace.codebaseHealth": { title: () => t(`workspace.workspaceDesktop.showCodebaseHealth`), category: WORKSPACE, icon: `wave-pulse` },
    "workspace.showHome": { title: () => t(`workspace.workspaceDesktop.showHome2`), category: WORKSPACE, icon: `th-large` },
    "workspace.toggleSidebar": { title: () => t(`workspace.workspaceDesktop.toggleExplorer2`), category: WORKSPACE, icon: `bars`, keybinding: `Ctrl+Shift+B` },
    // One chord toggles both directions; Ctrl+Shift+\ avoids bare Ctrl+\, which is SIGQUIT in a focused terminal.
    "workspace.splitEditor": {
        title: () => t(`workspace.workspaceDesktop.openTabToSide`),
        category: WORKSPACE,
        icon: `split-columns`,
        keybinding: `Ctrl+Shift+\\`,
        when: onSurface(`workspace`),
    },
    "workspace.unsplitEditor": { title: () => t(`workspace.workspaceDesktop.closeSplit`), category: WORKSPACE, icon: `split-columns` },
    // The explorer's two filters, reachable from the palette when the sidebar is collapsed and off-screen.
    "workspace.toggleIgnored": { title: () => t(`workspace.workspaceDesktop.toggleIgnoredFiles`), category: WORKSPACE, icon: `eye` },
    "workspace.toggleTests": { title: () => t(`workspace.workspaceDesktop.toggleTestFiles`), category: WORKSPACE, icon: `filter` },
    // Shared tab family with chat/terminal (tabSurface.ts resolves by focus); workspace is the fallback surface.
    "workspace.nextTab": { title: () => t(`workspace.workspaceDesktop.nextTab`), category: WORKSPACE, keybinding: `Alt+PageDown`, when: onSurface(`workspace`) },
    "workspace.previousTab": { title: () => t(`workspace.workspaceDesktop.previousTab`), category: WORKSPACE, keybinding: `Alt+PageUp`, when: onSurface(`workspace`) },
    "workspace.closeTab": {
        title: () => t(`workspace.workspaceDesktop.closeTab`),
        category: WORKSPACE,
        icon: `times`,
        keybinding: `Ctrl+Shift+X`,
        when: onSurface(`workspace`),
    },
    "workspace.closeOtherTabs": {
        title: () => t(`workspace.workspaceDesktop.closeOtherTabs`),
        category: WORKSPACE,
        icon: `times`,
        keybinding: `Ctrl+Shift+,`,
        when: onSurface(`workspace`),
    },
    "workspace.closeTabsToRight": {
        title: () => t(`workspace.workspaceDesktop.closeTabsToRight`),
        category: WORKSPACE,
        icon: `times`,
        keybinding: `Ctrl+Shift+.`,
        when: onSurface(`workspace`),
    },
    "workspace.closeAllTabs": {
        title: () => t(`workspace.workspaceDesktop.closeAllTabs`),
        category: WORKSPACE,
        icon: `times`,
        keybinding: `Ctrl+Shift+Backspace`,
        when: onSurface(`workspace`),
    },
    // Ctrl+Shift+O ("reOpen"), not VSCode's Ctrl+Shift+T: that reopens the browser's own tab and isn't cancellable.
    "workspace.reopenClosedTab": {
        title: () => t(`workspace.workspaceDesktop.reopenClosedTab`),
        category: WORKSPACE,
        icon: `undo`,
        keybinding: `Ctrl+Shift+O`,
        when: onSurface(`workspace`),
    },
    "workspace.refresh": { title: () => t(`workspace.workspaceDesktop.refreshFiles`), category: WORKSPACE, icon: `refresh` },
    // Mod+Z brings back the last delete wherever the caret isn't in a field or the code editor, which keep their own
    // undo; with nothing deleted the chord passes through untouched.
    "workspace.undoDelete": {
        title: () => t(`workspace.workspaceDesktop.undoDelete`),
        category: WORKSPACE,
        icon: `undo`,
        keybinding: `Mod+Z`,
        when: `workspaceDeleteUndoable && !editableTarget`,
    },

    // The terminal panel (TerminalPanel.vue, panelCommands.ts). Tab-family chords match the workspace and chat strips,
    // gated on this panel's focus; the panel's own verbs keep private, ungated Ctrl+Shift+<key> chords.
    // Cmd+F on a Mac, Ctrl+F elsewhere, gated to this panel so the page's own find keeps the chord everywhere else.
    "terminal.find": { title: () => t(`terminal.terminalPanel.find`), category: TERMINAL, icon: `search`, keybinding: `Mod+F`, when: onSurface(`terminal`) },
    // F2 is gated to a keystroke from inside this panel; outside it the chord stays free for other surfaces.
    "terminal.rename": { title: () => t(`ui.action.rename`), category: TERMINAL, icon: `pencil`, keybinding: `F2`, when: onSurface(`terminal`) },
    "terminal.changeColor": { title: () => t(`terminal.terminalPanel.changeColor2`), category: TERMINAL, icon: `palette` },
    "terminal.changeIcon": { title: () => t(`terminal.terminalPanel.changeIcon2`), category: TERMINAL, icon: `star` },
    "terminal.join": { title: () => t(`terminal.terminalPanel.joinSelected`), category: TERMINAL, icon: `code`, keybinding: `Ctrl+Shift+G` },
    "terminal.unsplit": { title: () => t(`terminal.terminalPanel.unsplit`), category: TERMINAL, icon: `code`, keybinding: `Ctrl+Shift+U` },
    "terminal.nextTab": { title: () => t(`ui.action.next`), category: TERMINAL, keybinding: `Alt+PageDown`, when: onSurface(`terminal`) },
    "terminal.previousTab": { title: () => t(`terminal.terminalPanel.previous`), category: TERMINAL, keybinding: `Alt+PageUp`, when: onSurface(`terminal`) },
    "terminal.split": { title: () => t(`terminal.terminalPanel.split`), category: TERMINAL, icon: `code`, keybinding: `Ctrl+Shift+5` },
    "terminal.kill": { title: () => t(`terminal.terminalPanel.kill`), category: TERMINAL, icon: `trash`, keybinding: `Ctrl+Shift+X`, when: onSurface(`terminal`) },
    "terminal.killAll": {
        title: () => t(`terminal.terminalPanel.killAll`),
        category: TERMINAL,
        icon: `trash`,
        keybinding: `Ctrl+Shift+Backspace`,
        when: onSurface(`terminal`),
    },
    // Unbound: tidying is occasional, and a chord for it would sit one slip from the one that kills your shell.
    "terminal.killInactive": { title: () => t(`terminal.terminalPanel.killInactive`), category: TERMINAL, icon: `trash` },

    // The agents board (boardCommands.ts). An archive says nothing, so it undoes by reflex; `when` hands the chord back
    // with nothing to undo or in a field. The filter is unbound: Mod+F is the browser's.
    "agents.undoArchive": {
        title: () => t(`agents.agentsView.undoArchive`),
        category: AGENTS,
        icon: `history`,
        keybinding: `Mod+Z`,
        when: `agentsUndoable && !editableTarget`,
    },
    "agents.filter": { title: () => t(`ui.action.filter`), category: AGENTS, icon: `search` },

    // The review pass (reviewKeys.ts): bare letters and arrows, gated off any field with the caret. A command carries one
    // chord, so the arrows are commands of their own beside j and k.
    "agents.review.nextFile": { title: () => t(`agents.agentReviewPanel.nextFile`), category: AGENTS, icon: `chevron-down`, keybinding: `j`, when: REVIEW_WHEN },
    "agents.review.previousFile": { title: () => t(`agents.agentReviewPanel.previousFile`), category: AGENTS, icon: `chevron-up`, keybinding: `k`, when: REVIEW_WHEN },
    "agents.review.nextFile.arrow": {
        title: () => t(`agents.agentReviewPanel.nextFile`),
        category: AGENTS,
        icon: `chevron-down`,
        keybinding: `ArrowDown`,
        when: REVIEW_WHEN,
    },
    "agents.review.previousFile.arrow": {
        title: () => t(`agents.agentReviewPanel.previousFile`),
        category: AGENTS,
        icon: `chevron-up`,
        keybinding: `ArrowUp`,
        when: REVIEW_WHEN,
    },
    "agents.review.markViewed": { title: () => t(`agents.agentReviewPanel.markReviewed`), category: AGENTS, icon: `check`, keybinding: `v`, when: REVIEW_WHEN },
    "agents.review.markGroupViewed": {
        title: () => t(`agents.agentReviewPanel.markGroupReviewed`),
        category: AGENTS,
        icon: `check-check`,
        keybinding: `Shift+V`,
        when: REVIEW_WHEN,
    },
} as const satisfies Record<string, CommandDeclaration>;

export type BuiltinCommand = keyof typeof BUILTIN_COMMANDS;

/** Alt+1…9's commands, the Nth for the Nth sandbox in the switcher's list; a local window answers the same ones. */
export const SANDBOX_SWITCH_COMMANDS = [
    `sandbox.switch1`,
    `sandbox.switch2`,
    `sandbox.switch3`,
    `sandbox.switch4`,
    `sandbox.switch5`,
    `sandbox.switch6`,
    `sandbox.switch7`,
    `sandbox.switch8`,
    `sandbox.switch9`,
] as const satisfies readonly BuiltinCommand[];

/** One built-in command's declaration. */
const builtinCommand = (command: BuiltinCommand): CommandDeclaration => BUILTIN_COMMANDS[command];

/** What a surface may say of a declared command beyond its handler: a title worded by its state (a toggle that says
 *  which way it goes), or a default chord of the window's own (the desktop app's window takes Mod+W, a browser tab cannot). */
export interface BuiltinBinding {
    readonly title?: () => string;
    readonly keybinding?: string;
}

/** The registry entry for a declared command: its declaration, and the handler the mounted surface gives it. */
export const builtinRegistration = (command: BuiltinCommand, handler: CommandRegistration[`handler`], binding: BuiltinBinding = {}): CommandRegistration => {
    const declared = builtinCommand(command);
    const name = binding.title ?? declared.title;
    return {
        owner: `builtin`,
        command,
        // A getter, so the palette and the Keyboard page read it in the language and the state of the moment.
        get title(): string {
            return name();
        },
        category: declared.category,
        icon: declared.icon,
        keybinding: binding.keybinding ?? declared.keybinding,
        when: declared.when,
        handler,
    };
};

/** Binds a handler to a declared command for as long as the caller holds the disposable. */
export const registerBuiltin = (command: BuiltinCommand, handler: CommandRegistration[`handler`], binding?: BuiltinBinding): Disposable =>
    registerCommand(builtinRegistration(command, handler, binding));

/** One row of the keymap: a command as the Keyboard page reads it, whether or not anything here can run it right now. */
export type KeymapCommand = Pick<CommandRegistration, `owner` | `command` | `title` | `category` | `keybinding` | `when`>;

const declaredRow = (command: string, declared: CommandDeclaration): KeymapCommand => ({
        owner: `builtin`,
        command,
        get title(): string {
            return declared.title();
        },
        category: declared.category,
        keybinding: declared.keybinding,
        when: declared.when,
});

/** Every command a person can bind: what is registered in this window (a live title, an extension's own), and every
 *  declared built-in it has not mounted. The keymap is this device's, so it is the same list in any window. */
export const keymapCommands = computed<readonly KeymapCommand[]>(() => {
    const live = commands.value;
    const registered = new Set(live.map((entry) => entry.command));
    const declared = Object.entries(BUILTIN_COMMANDS)
        .filter(([command, declaration]: [string, CommandDeclaration]) => !registered.has(command) && (declaration.offered?.() ?? true))
        .map(([command, declaration]) => declaredRow(command, declaration));
    return [...live, ...declared];
});
