import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { ViewerPicture } from "../attachments/PictureViewer.vue";
import { type QuickLookBox, quickLookBoxAt } from "../attachments/pictureQuickLook";
import type { PageAsk, PagePicture, PagePictureLook } from "./pageBridge";

// The pictures on a page the agent showed, looked at the way a finished turn's own screenshots are (ChatTurnShots): a
// pointer resting on one floats it bigger (pictureQuickLook), and a press opens it large in the chat's picture viewer,
// walking every such picture on the page. The page's half (sandbox-contract text/pages.ts) says which picture and where;
// this half decides whether to believe it. A look is drawn only while a mouse is over the frame, inside the frame's own
// box, so a page's script cannot float a picture over the chat by itself; a press is ChatPageFrame's to vouch for.

// How far from the frame's edge the pointer may last have been seen over the chat itself and still count as having
// gone into the frame: a quick move crosses the edge between two of its events.
const ENTRY_SLACK = 96;

const DOWNLOAD_HOLD_MS = 60_000;

// What a picture's data says it is, as a file's extension; the picture types a page carries, and `png` for any other.
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
    [`png`, `png`],
    [`jpeg`, `jpg`],
    [`jpg`, `jpg`],
    [`gif`, `gif`],
    [`webp`, `webp`],
    [`avif`, `avif`],
    [`svg+xml`, `svg`],
    [`bmp`, `bmp`],
]);

// A picture's data as the bytes it holds, for a download: a long `data:` address is more than a link can carry.
const pictureBlob = (src: string): Blob => {
    const comma = src.indexOf(`,`);
    const head = src.slice(5, comma);
    const body = src.slice(comma + 1);
    const type = head.split(`;`)[0] ?? ``;
    if (!head.endsWith(`;base64`)) {
        return new Blob([decodeURIComponent(body)], { type });
    }
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type });
};

// A file name a picture saves under: its words where the page gave it some, and its place on the page where not.
const fileName = (picture: PagePicture, name: string): string => {
    const subtype = /^data:image\/([\w.+-]+)/i.exec(picture.src)?.[1]?.toLowerCase() ?? ``;
    const stem = name.replace(/[\\/:*?"<>|\s]+/g, `-`).replace(/^-+|-+$/g, ``) || `picture`;
    return `${stem.slice(0, 80)}.${EXTENSIONS.get(subtype) ?? `png`}`;
};

// The look: the picture the pointer rests on, floated bigger beside the page while the mouse is over its frame.
const usePictureLook = (frame: Readonly<Ref<HTMLIFrameElement | null>>) => {
    const shown = ref<{ readonly picture: PagePicture; readonly box: QuickLookBox }>();
    const hide = (): void => {
        shown.value = undefined;
    };

    // Where a mouse was last seen over the chat itself. Over a frame the chat hears nothing (the frame's own document
    // has the events, and the frame element no `pointerenter` nor `:hover`), so that place is where the pointer crossed
    // into a frame, and the mouse is over this one only while it was at this frame's edge. Seen over the chat again, it
    // has left: the look goes with it. A touch has no hover, and opens a picture with its press instead.
    let seenAt: { readonly x: number; readonly y: number } | undefined;
    const seen = (event: PointerEvent): void => {
        if (event.pointerType === `touch`) {
            return;
        }
        seenAt = { x: event.clientX, y: event.clientY };
        hide();
    };
    const entered = (box: DOMRect): boolean =>
        seenAt !== undefined &&
        seenAt.x >= box.left - ENTRY_SLACK &&
        seenAt.x <= box.right + ENTRY_SLACK &&
        seenAt.y >= box.top - ENTRY_SLACK &&
        seenAt.y <= box.bottom + ENTRY_SLACK;

    // The page says the pointer rests on `picture` (drawn at `rect` in the frame's coordinates), or on none.
    const look = (picture: PagePictureLook | undefined): void => {
        const el = frame.value;
        const box = el?.getBoundingClientRect();
        if (picture === undefined || el === null || box === undefined || !entered(box)) {
            hide();
            return;
        }
        const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
        const left = clamp(box.left + picture.rect.left, box.left, box.right);
        const top = clamp(box.top + picture.rect.top, box.top, box.bottom);
        const right = clamp(box.left + picture.rect.left + picture.rect.width, left, box.right);
        const bottom = clamp(box.top + picture.rect.top + picture.rect.height, top, box.bottom);
        if (right - left < 1 || bottom - top < 1) {
            hide();
            return;
        }
        shown.value = { picture, box: quickLookBoxAt(el, { left, top, right, bottom, width: right - left, height: bottom - top }, picture.aspect) };
    };

    // The chat scrolling carries the picture away from under its look.
    onMounted(() => {
        window.addEventListener(`scroll`, hide, { capture: true, passive: true });
        document.addEventListener(`pointermove`, seen, { capture: true, passive: true });
    });
    onBeforeUnmount(() => {
        window.removeEventListener(`scroll`, hide, { capture: true });
        document.removeEventListener(`pointermove`, seen, { capture: true });
        hide();
    });

    return { shown, look, hide };
};

// The viewer: what the press handed it, and where it stands, by place on the page.
const usePictureViewer = () => {
    const t = useT();
    const viewing = ref(false);
    const opened = ref<readonly PagePicture[]>([]);
    const at = ref<string>();
    const nameOf = (picture: PagePicture, index: number): string => picture.alt || t(`chat.chatPages.picture`, { index: index + 1 });
    const pictures = computed<readonly ViewerPicture[]>(() =>
        opened.value.map((picture, index) => ({ key: String(index), name: nameOf(picture, index), tile: picture.src, group: 0 })),
    );
    const current = computed(() => {
        const index = Math.max(0, Number(at.value ?? 0));
        const picture = opened.value[index];
        return picture === undefined ? undefined : { picture, index };
    });
    const drawn = computed(() => (current.value === undefined ? undefined : { url: current.value.picture.src }));

    const open = (list: readonly PagePicture[], index: number): void => {
        opened.value = list;
        at.value = String(index);
        viewing.value = true;
    };

    const download = (): void => {
        const shownNow = current.value;
        if (shownNow === undefined) {
            return;
        }
        const url = URL.createObjectURL(pictureBlob(shownNow.picture.src));
        const link = document.createElement(`a`);
        link.href = url;
        link.download = fileName(shownNow.picture, nameOf(shownNow.picture, shownNow.index));
        link.click();
        // Held past the click: a browser that starts the download a beat later would otherwise find the bytes gone.
        setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_HOLD_MS);
    };

    return { viewing, at, pictures, drawn, open, download };
};

export const usePagePictures = (frame: Readonly<Ref<HTMLIFrameElement | null>>) => {
    const { shown, look, hide } = usePictureLook(frame);
    const { viewing, at, pictures, drawn, open, download } = usePictureViewer();

    // A picture ask, acted on and taken (true), or any other, left for the frame (false). A press opens the viewer only
    // when `pressed` vouches the reader just pressed something in the frame.
    const take = (ask: PageAsk, pressed: () => boolean): boolean => {
        if (ask.kind === `pictureLook`) {
            look(ask.picture);
            return true;
        }
        if (ask.kind === `pictureOpen`) {
            if (pressed()) {
                hide();
                open(ask.pictures, ask.index);
            }
            return true;
        }
        return false;
    };

    return { shown, take, viewing, at, pictures, drawn, download };
};
