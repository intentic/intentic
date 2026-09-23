import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { clipboardOf } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";
import { onScopeDispose, type Ref, ref } from "vue";
import type { useNotifications } from "../../../../shell/notifications/notifications";
import type { useUploadQueue } from "../../files/upload/useUploadQueue";
import { joinPath } from "../entryNames";
import { filesOffered } from "../transfer/dragSource";
import { filesToEntries } from "../transfer/dropEntries";
import { movableInto, pastePairs } from "../transfer/explorerPaste";
import { beginEntryDrag, useEntryDrag } from "../transfer/useEntryDrag";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { isUnlisted } from "./treeRows";
import type { useInlineEdit } from "./useTreeEdits";
import type { useTreeRules } from "./useTreeRules";
import type { useTreeSelection } from "./useTreeSelection";

// Entries into, out of and around a file surface (the tree, the home); a pointer move never uses the platform's drag.

export interface TreeTransferHost {
    readonly tree: () => readonly WorkspaceTreeEntry[];
    // The tree's own root: not one of its rows, so its listing is `tree` itself.
    readonly rootDir: () => string;
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly childrenOf: (entry: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[];
    readonly targetDir: (path: string | null) => string;
    readonly openFolder: (dir: string) => void;
    readonly rules: Pick<ReturnType<typeof useTreeRules>, "unlockedOnly" | "archived" | "noDrops" | "refuseIn">;
    readonly selecting: Pick<ReturnType<typeof useTreeSelection>, "selection" | "lead" | "selectLanded">;
    readonly inline: Pick<ReturnType<typeof useInlineEdit>, "edit" | "editing">;
    // The tree element: a clipboard write goes through its window, so a popped-out explorer writes to its own.
    readonly el: Readonly<Ref<HTMLElement | undefined>>;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "clipboard" | "run" | "copyEntries" | "moveIntoMany" | "extractEntry" | "loadChildren">;
    readonly uploads: Pick<ReturnType<typeof useUploadQueue>, "enqueue" | "enqueueFromDataTransfer">;
    readonly say: ReturnType<typeof useNotifications>["say"];
}

export const useTreeTransfer = (host: TreeTransferHost) => {
    const { store, rules, selecting } = host;
    const { selection, lead } = selecting;
    const { clipboard } = store;

    // Stages the selection, or the lead alone when nothing is selected. `async` also writes the paths as text to the OS
    // clipboard, since the menu has no clipboard event to hook.
    const stage = (mode: "copy" | "cut", system: "async" | "event"): readonly string[] => {
        const led = lead.value;
        const paths = rules.unlockedOnly(selection.value.size > 0 ? [...selection.value] : led !== null ? [led] : []);
        if (paths.length === 0) {
            return paths;
        }
        clipboard.value = { mode, paths };
        if (system === `async`) {
            void clipboardOf(host.el.value)
                .writeText(paths.join(`\n`))
                .catch(() => undefined);
        }
        return paths;
    };

    // Names already in the target dir; an unlisted dir is fetched first, so the check isn't made against a placeholder.
    const namesIn = async (dir: string): Promise<ReadonlySet<string>> => {
        const target = dir === host.rootDir() ? undefined : host.byPath.value.get(dir);
        if (target !== undefined && isUnlisted(target)) {
            await store.loadChildren(dir);
        }
        const siblings = target === undefined ? host.tree() : host.childrenOf(target);
        return new Set(siblings.map((child) => child.name));
    };
    // Opens the target dir and selects what landed, so a paste into a collapsed folder isn't invisible.
    const revealLanded = (dir: string, paths: readonly string[]): void => {
        host.openFolder(dir);
        selecting.selectLanded(paths);
    };
    // A copy never overwrites, landing under a free name ("<name> copy"). Revealed before the write is awaited: its rows
    // are already on screen, and selecting them after the round trip would make the paste look like nothing happened.
    const copyInto = async (paths: readonly string[], dir: string, whenRefused: string): Promise<void> => {
        const pairs = pastePairs(paths, dir, await namesIn(dir));
        if (pairs.length === 0) {
            return;
        }
        const write = store.run(() => store.copyEntries(pairs), whenRefused);
        revealLanded(
            dir,
            pairs.map((pair) => pair.to),
        );
        await write;
    };
    // A cut moves and consumes the clipboard; a copy leaves it for the next paste.
    const paste = async (dir: string): Promise<void> => {
        const clip = clipboard.value;
        if (clip === undefined || rules.refuseIn(dir)) {
            return;
        }
        if (clip.mode === `copy`) {
            await copyInto(clip.paths, dir, `Couldn't paste those items.`);
            return;
        }
        const sources = movableInto(clip.paths, dir);
        clipboard.value = undefined;
        if (sources.length === 0) {
            return;
        }
        const write = store.run(() => store.moveIntoMany(sources, dir), `Couldn't move those items.`);
        revealLanded(
            dir,
            sources.map((source) => joinPath(dir, basename(source))),
        );
        await write;
    };

    // The tree owns the clipboard's events only while it holds focus; an open inline field owns its own.
    const onCopyEvent = (event: ClipboardEvent, mode: "copy" | "cut"): void => {
        if (host.inline.editing.value) {
            return;
        }
        const paths = stage(mode, `event`);
        if (paths.length === 0) {
            return;
        }
        // Publishing as text makes the copy usable outside the tree, overwriting whatever the OS clipboard held.
        event.clipboardData?.setData(`text/plain`, paths.join(`\n`));
        event.preventDefault();
    };
    // OS files win over the internal clipboard: a copy made here always overwrites the clipboard's text.
    const onPasteEvent = (event: ClipboardEvent): void => {
        if (host.inline.editing.value) {
            return;
        }
        const dir = host.targetDir(lead.value);
        const files = event.clipboardData?.files;
        if (files !== undefined && files.length > 0) {
            event.preventDefault();
            if (!rules.refuseIn(dir)) {
                host.openFolder(dir);
                void host.uploads.enqueue(dir, filesToEntries(files));
            }
            return;
        }
        if (clipboard.value === undefined) {
            return;
        }
        event.preventDefault();
        void paste(dir);
    };

    // Where a dragged row lands. Out of an archive it is a copy: the member stays in the archive, since nothing here
    // rewrites one, and a drag that silently deleted from a zip would be the wrong surprise either way.
    const dragOnto = async (paths: readonly string[], dir: string): Promise<void> => {
        if (paths.some((path) => rules.archived(path))) {
            await copyInto(paths, dir, `Couldn't copy those items out.`);
            return;
        }
        await store.run(() => store.moveIntoMany(paths, dir), `Couldn't move those items.`);
    };
    // Every press reaches beginEntryDrag, carrying nothing when it cannot travel: that is what ends a drag's claim on a click.
    const onPointerDown = (event: PointerEvent, path: string): void => {
        const edit = host.inline.edit.value;
        const modified = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;
        const held =
            modified || (edit.kind === `renaming` && edit.path === path)
                ? []
                : // Dragging a selected entry moves the whole selection; otherwise just that entry.
                  rules.unlockedOnly(selection.value.has(path) ? [...selection.value] : [path]);
        beginEntryDrag(event, { paths: held, onDrop: (dir) => void dragOnto(held, dir) });
    };
    const { dragging, paths: dragged, over } = useEntryDrag();
    // Dimmed while it travels.
    const carried = (path: string): boolean => dragging.value && dragged.value.includes(path);

    // The folder an OS file drag is over; undefined over nothing, or over a folder that takes no drop.
    const dropDir = ref<string | undefined>(undefined);
    // Lit as where a drop would land, by either drag.
    const dropLit = (path: string): boolean => path === dropDir.value || path === over.value;
    // OS files only: any other drag is left alone, so the browser declines it. Stopped here, so no zone behind claims it too.
    const onDragOver = (event: DragEvent, dir: string): void => {
        if (!filesOffered(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const invalid = rules.noDrops(dir);
        if (event.dataTransfer !== null) {
            event.dataTransfer.dropEffect = invalid ? `none` : `copy`;
        }
        dropDir.value = invalid ? undefined : dir;
    };
    // `dragleave` also fires when the pointer crosses into a child; only a real exit clears the target.
    const onDragLeave = (event: DragEvent, dir: string): void => {
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(to)) {
            return;
        }
        if (dropDir.value === dir) {
            dropDir.value = undefined;
        }
    };
    // A refused drop is swallowed here, so it can't bubble to the root and land files unexpectedly.
    const onDrop = (event: DragEvent, dir: string): void => {
        if (event.dataTransfer === null || !filesOffered(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dropDir.value = undefined;
        if (rules.noDrops(dir) || rules.refuseIn(dir)) {
            return;
        }
        // Opened before the files are read, so the placeholder rows appear inside the folder that took the drop.
        host.openFolder(dir);
        // Synchronous, since webkitGetAsEntry must fire while the drag items are still alive.
        host.uploads.enqueueFromDataTransfer(dir, event.dataTransfer);
    };
    // A file drag that ends anywhere (dropped elsewhere, cancelled) clears the hint; capture, so a stopped drop counts.
    const clearDropDir = (): void => {
        dropDir.value = undefined;
    };
    window.addEventListener(`dragend`, clearDropDir, true);
    window.addEventListener(`drop`, clearDropDir, true);
    onScopeDispose(() => {
        window.removeEventListener(`dragend`, clearDropDir, true);
        window.removeEventListener(`drop`, clearDropDir, true);
    });

    // Unpacks an archive into the folder holding it, selected once the daemon answers: only it can say what the entry is
    // called, and a guessed name would mark the wrong row whenever the archive turned out to hold its own folder.
    const extract = async (path: string): Promise<void> => {
        if (rules.refuseIn(host.targetDir(path))) {
            return;
        }
        await store.run(async () => {
            const landed = await store.extractEntry(path);
            revealLanded(parentDir(landed), [landed]);
            host.say(`Extracted to ${basename(landed)}`);
        }, `Couldn't extract that.`);
    };

    return { stage, paste, extract, onCopyEvent, onPasteEvent, onPointerDown, carried, dropDir, dropLit, onDragOver, onDragLeave, onDrop };
};
