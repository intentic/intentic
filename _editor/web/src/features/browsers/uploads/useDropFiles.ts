import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import type { WindowToolsSeams } from "../windowTools";
import { dropPoint, type PictureGeometry } from "./dropPoint";
import { filesOf, type FileTools } from "./useFileTools";

// Files dragged from the person's desktop onto the picture of a page: the stage says it will take them, and a drop
// sends them up and puts them down on the page at the point they landed, in the page's own pixels (dropPoint.ts).
// Listened for on the stage element itself, so the stage's own pointer and key handlers are left as they are.

export interface DropInput {
    readonly window: Ref<string | undefined>;
    readonly page: Ref<BrowserPage | undefined>;
    readonly usable: Ref<boolean>;
    readonly stage: Ref<HTMLElement | null>;
    readonly geometry: () => PictureGeometry | undefined;
}

export const useDropFiles = (seams: WindowToolsSeams, files: FileTools, input: DropInput) => {
    const dragging = ref(false);
    const carriesFiles = (event: DragEvent): boolean => input.usable.value && (event.dataTransfer?.types.includes(`Files`) ?? false);
    const onDragOver = (event: DragEvent): void => {
        if (carriesFiles(event)) {
            event.preventDefault();
            dragging.value = true;
        }
    };
    const onDragLeave = (): void => {
        dragging.value = false;
    };
    const onDrop = (event: DragEvent): void => {
        dragging.value = false;
        const dropped = filesOf(event.dataTransfer?.files);
        const geometry = input.geometry();
        const name = input.window.value;
        const page = input.page.value;
        if (!carriesFiles(event) || dropped.length === 0 || geometry === undefined || name === undefined || page === undefined) {
            return;
        }
        event.preventDefault();
        const at = dropPoint(event, geometry);
        if (at === undefined) {
            return;
        }
        void files.handing(async () => {
            const uploads = await files.send(dropped);
            await seams.browser.dropFiles({ name, pageId: page.id, x: at.x, y: at.y, uploads });
        });
    };
    const listen = (stage: HTMLElement | null | undefined): void => {
        stage?.addEventListener(`dragover`, onDragOver);
        stage?.addEventListener(`dragleave`, onDragLeave);
        stage?.addEventListener(`drop`, onDrop);
    };
    const unlisten = (stage: HTMLElement | null | undefined): void => {
        stage?.removeEventListener(`dragover`, onDragOver);
        stage?.removeEventListener(`dragleave`, onDragLeave);
        stage?.removeEventListener(`drop`, onDrop);
    };
    watch(
        input.stage,
        (stage, before) => {
            unlisten(before);
            listen(stage);
        },
        { immediate: true },
    );
    onScopeDispose(() => unlisten(input.stage.value));
    return { dragging };
};
