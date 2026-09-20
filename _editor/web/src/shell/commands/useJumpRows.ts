import { iconForEntry, type IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, type Ref } from "vue";
import { useRouter } from "vue-router";
import { nameScore, rankCommands } from "./commandSearch";
import { groupJumpRows, type JumpGroup, type JumpKind, parseJumpQuery, type ScoredRow, UNSCOPED_CAP } from "./jumpSearch";
import { formatChord, isApplePlatform } from "./keybindings";
import { recentCommandIds, rememberCommand } from "./recentCommands";
import { commandLabel, commands, executeCommand, type RegisteredCommand } from "./useCommands";
import { effectiveKeybinding } from "./useKeymap";
import { agentDisplayTitle, agentStatusMeta } from "../../features/agents/fleet/agentStatus";
import { sessionIdFrom } from "../../features/agents/fleet/sessionRef";
import { useAgents } from "../../features/agents/fleet/useAgents";
import { useRole } from "../../features/sandbox/secrets/useRole";
import { useTerminalsQuery } from "../../features/terminal/terminalsQuery";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { fuzzyScore } from "../../features/workspace/search/fuzzyPaths";
import { useFuzzyFiles } from "../../features/workspace/search/useFuzzyFiles";
import { useWorkspaceTabs } from "../../features/workspace/tabs/useWorkspaceTabs";

// Every source the palette can answer from, as one list of rows: the fleet, the workspace's files, the sandbox's
// terminals and the command registry. Each kind ranks its own rows (jumpSearch orders the kinds against each other),
// and each row carries what it takes to draw and to run it, so QuickOpen.vue holds a list and a keyboard and nothing
// about where a row came from.

export interface PaletteRow extends ScoredRow {
    // Unique across kinds: the active row and the scroll map key off it.
    readonly key: string;
    readonly title: string;
    // Dimmed after the title: a file's folder, an agent's standing, what a terminal is running, a command's id.
    readonly detail: string | undefined;
    readonly icon: IconName;
    // Tint for the icon, an agent's status colour; absent draws it muted, as every other kind is.
    readonly tone: string | undefined;
    // Right-aligned chord, for a command bound to one.
    readonly chord: string | undefined;
    // Listed from history rather than matched: open tabs, commands run recently. Heads its own block.
    readonly recent: boolean;
    readonly run: () => void;
}

export interface JumpSection {
    readonly kind: JumpKind;
    readonly heading: string;
    readonly rows: readonly PaletteRow[];
}

const headingOf = (kind: JumpKind, recent: boolean): string => {
    switch (kind) {
        case `agent`:
            return t(`shell.quickOpen.agents`);
        case `file`:
            return recent ? t(`shell.quickOpen.recentlyOpened`) : t(`shell.quickOpen.files`);
        case `terminal`:
            return t(`shell.quickOpen.terminals`);
        default:
            return recent ? t(`shell.quickOpen.recentCommands`) : t(`shell.quickOpen.commands`);
    }
};

// One kind, one heading — except the commands half with nothing typed, which opens on what was run recently and ranks
// the rest below it. Two headings there, and only there: a query has one answer, ranked.
const sectionsOf = (group: JumpGroup<PaletteRow>): readonly JumpSection[] => {
    const recent = group.rows.filter((row) => row.recent);
    if (recent.length === 0 || recent.length === group.rows.length) {
        return [{ kind: group.kind, heading: headingOf(group.kind, recent.length > 0), rows: group.rows }];
    }
    return [
        { kind: group.kind, heading: t(`shell.quickOpen.recentlyUsed`), rows: recent },
        { kind: group.kind, heading: t(`shell.quickOpen.allCommands`), rows: group.rows.slice(recent.length) },
    ];
};

export function useJumpRows(query: Ref<string>, isOpen: Ref<boolean>) {
    const router = useRouter();
    const { fleet, agentById } = useAgents();
    const { tabs } = useWorkspaceTabs();
    const { sessions } = useTerminalsQuery();
    const { canShip } = useRole();
    const terminal = useTerminalPanel();
    // Resolved once so command rows render their shortcut in native form (⇧⌘P vs Ctrl+Shift+P).
    const isMac = isApplePlatform();

    const parsed = computed(() => parseJumpQuery(query.value));
    const text = computed(() => parsed.value.text);
    const wants = (kind: JumpKind): boolean => parsed.value.kind === undefined || parsed.value.kind === kind;

    const openAgent = (id: string): void => void router.push({ name: `agent`, params: { id } });
    // Navigates to the file's workspace URL; useWorkspaceRoute opens it, whichever area we're coming from.
    const openFile = (path: string): void => void router.push({ name: `workspace`, params: { path: path.split(`/`) } });

    // A pasted session id takes over the palette; any of its four spellings are accepted (sessionRef). Read off the raw
    // query when unscoped, since one of those spellings is an absolute worktree path.
    const sessionRef = computed(() => {
        if (parsed.value.kind !== undefined && parsed.value.kind !== `agent`) {
            return undefined;
        }
        return sessionIdFrom(parsed.value.kind === undefined ? query.value : text.value, (id) => agentById(id) !== undefined);
    });

    const agentRows = computed<readonly PaletteRow[]>(() => {
        if (!wants(`agent`)) {
            return [];
        }
        return fleet.value
            .flatMap((agent): PaletteRow[] => {
                const title = agentDisplayTitle(agent);
                // The branch stands in for the id: it is the spelling a reader has actually seen (`agent/<id>`).
                const score = nameScore(title, agent.branch ?? agent.id, text.value);
                if (score === undefined) {
                    return [];
                }
                const meta = agentStatusMeta(agent.status);
                return [
                    {
                        kind: `agent`,
                        key: `agent:${agent.id}`,
                        score,
                        title,
                        detail: meta.label,
                        icon: meta.icon,
                        tone: meta.class,
                        chord: undefined,
                        recent: false,
                        run: () => openAgent(agent.id),
                    },
                ];
            })
            // Stable, so an unqueried palette keeps the fleet's own order: what needs you, then what you touched last.
            .toSorted((left, right) => right.score - left.score);
    });

    // Idle while a session reference is showing, and while the query is scoped to another kind.
    const filesActive = computed(() => isOpen.value && wants(`file`) && sessionRef.value === undefined);
    const { paths: filePaths, floor, searching, pending, truncated, error } = useFuzzyFiles(text, filesActive);
    // Below the search floor the file half lists what is already open, which is the other half of "go to a file".
    const listingTabs = computed(() => text.value.length < floor.value);

    const fileRows = computed<readonly PaletteRow[]>(() => {
        if (!wants(`file`)) {
            return [];
        }
        const paths = listingTabs.value ? tabs.value.flatMap((tab) => (tab.kind === `file` ? [tab.path] : [])) : filePaths.value;
        return paths.map((path) => ({
            kind: `file`,
            key: `file:${path}`,
            // Clamped: fuzzyScore's short-path bonus can exceed 1, which would outrank every other kind by arithmetic.
            score: listingTabs.value ? 0 : Math.min(1, fuzzyScore(text.value, path) ?? 0),
            title: basename(path),
            detail: parentDir(path),
            icon: iconForEntry(basename(path), `file`, false),
            tone: undefined,
            chord: undefined,
            recent: listingTabs.value,
            run: () => openFile(path),
        }));
    });

    const terminalRows = computed<readonly PaletteRow[]>(() => {
        // Terminals are a maintainer's surface: below it the daemon refuses the socket, so there is nothing to offer.
        if (!wants(`terminal`) || !canShip.value) {
            return [];
        }
        // Unscoped, only the sessions someone keeps — an agent's own shell, a job and a background process are listed
        // when the palette is pointed at terminals and not before, exactly as the panel's strip hides them.
        const kept = parsed.value.kind === `terminal` ? sessions.value : sessions.value.filter((session) => session.kind === `shell` || session.kind === `panel`);
        return kept
            .flatMap((session): PaletteRow[] => {
                const title = session.label ?? session.name;
                const score = nameScore(title, session.name, text.value);
                if (score === undefined) {
                    return [];
                }
                return [
                    {
                        kind: `terminal`,
                        key: `terminal:${session.name}`,
                        score,
                        title,
                        detail: session.command,
                        icon: `code`,
                        tone: session.running ? undefined : `text-subtle`,
                        chord: undefined,
                        recent: false,
                        run: () => terminal.openFocused(session.name),
                    },
                ];
            })
            .toSorted((left, right) => right.score - left.score);
    });

    // Commands run recently, in that order, dropped as soon as a query is typed: ranking is a better answer than habit
    // once someone has said what they're after. A remembered command whose surface isn't mounted is simply not listed.
    const recentCommands = computed<readonly RegisteredCommand[]>(() =>
        text.value.length > 0
            ? []
            : recentCommandIds.value.flatMap((id) => {
                  const entry = commands.value.find((candidate) => candidate.command === id);
                  return entry === undefined ? [] : [entry];
              }),
    );

    const commandRow = (entry: RegisteredCommand, recent: boolean): PaletteRow => {
        // The effective chord (override or default), read reactively so a live remap updates the hint.
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        return {
            kind: `command`,
            key: `command:${entry.command}`,
            score: nameScore(commandLabel(entry), entry.command, text.value) ?? 0,
            title: commandLabel(entry),
            detail: entry.command,
            icon: (entry.icon ?? `chevron-right`) as IconName,
            tone: undefined,
            chord: chord === undefined ? undefined : formatChord(chord, isMac),
            recent,
            run: (): void => {
                // Remembered on the press, not on success: what the reader reached for is the same either way.
                rememberCommand(entry.command);
                // A throwing command is its owner's bug: contain it to the console, never the palette.
                void Promise.resolve(executeCommand(entry.command)).catch((caught: unknown) => console.error(`command ${entry.command} failed`, caught));
            },
        };
    };

    const commandRows = computed<readonly PaletteRow[]>(() => {
        if (!wants(`command`)) {
            return [];
        }
        const recent = recentCommands.value;
        // An unqueried palette is a list of the reader's own things — agents, open files, commands they have run — so
        // the registry's alphabetical head is not offered beside them. The `>` scope is where the whole list lives.
        if (parsed.value.kind === undefined && text.value === ``) {
            return recent.map((entry) => commandRow(entry, true));
        }
        const ranked = rankCommands(commands.value, text.value).filter((entry) => !recent.includes(entry));
        return [...recent.map((entry) => commandRow(entry, true)), ...ranked.map((entry) => commandRow(entry, false))];
    });

    const sections = computed<readonly JumpSection[]>(() => {
        const id = sessionRef.value;
        if (id !== undefined) {
            // One offer, since a session reference means one thing; the id is echoed so the reader can verify the match.
            const agent = agentById(id);
            return [
                {
                    kind: `agent`,
                    heading: t(`shell.quickOpen.agent`),
                    rows: [
                        {
                            kind: `agent`,
                            key: `agent:${id}`,
                            score: 1,
                            title: agent === undefined ? t(`shell.quickOpen.openAgent`) : agentDisplayTitle(agent),
                            detail: id,
                            icon: `robot`,
                            tone: undefined,
                            chord: undefined,
                            recent: false,
                            run: () => openAgent(id),
                        },
                    ],
                },
            ];
        }
        const rows = [...agentRows.value, ...fileRows.value, ...terminalRows.value, ...commandRows.value];
        return groupJumpRows(rows, parsed.value.kind === undefined ? UNSCOPED_CAP : Number.POSITIVE_INFINITY).flatMap(sectionsOf);
    });

    return {
        parsed,
        sections,
        rows: computed<readonly PaletteRow[]>(() => sections.value.flatMap((section) => section.rows)),
        floor,
        // The file half's own state: it is the one source that can be slow, truncated, or refused.
        searching,
        pending,
        truncated,
        error,
    };
}
