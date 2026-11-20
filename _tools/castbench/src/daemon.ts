import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { BrowserContext, CDPSession, Page } from "playwright";

// The daemon's own browser-cast modules, loaded from its source at run time, so the legacy column measures exactly what
// a sandbox runs today: the ffmpeg command line `encoderArgs` builds, the access-unit split, the frame gate that drops
// frames behind a slow socket and restarts the encoder for a keyframe, the window placement and the viewport crop. A
// copy would drift from the code it claims to measure the day either changed. Loaded by path, not as a dependency, since
// the daemon is no package anything else imports; Bun resolves its imports from its own node_modules. Only the members
// used below are typed here: a change of shape in the daemon fails the run where it is called, which is the point.

const CAST = join(repoRoot(import.meta.url), "_sandbox/sandbox/src/browser/cast");

export interface Region {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
}

export interface WindowGeometry {
    readonly screenX: number;
    readonly screenY: number;
    readonly outerWidth: number;
    readonly outerHeight: number;
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly dpr: number;
}

export interface VideoFrame {
    readonly bytes: Buffer;
    readonly key: boolean;
}

export interface FrameGate {
    readonly admit: (frame: VideoFrame) => boolean;
    readonly askKey: () => void;
    readonly started: () => void;
    readonly stop: () => void;
}

interface VideocastModule {
    readonly startVideocast: (
        display: { readonly name: string },
        region: Region,
        handlers: { readonly onFrame: (frame: VideoFrame) => void; readonly onCodec: (codec: string) => void; readonly onExit: (reason: string) => void },
    ) => { readonly stop: () => void };
    readonly frameGate: (options: { readonly backlog: () => number; readonly restart: () => void }) => FrameGate;
    readonly encodeVideo: (frame: VideoFrame, quiet?: boolean) => Uint8Array<ArrayBuffer>;
}

interface RegionModule {
    readonly regionOf: (geometry: WindowGeometry, screen: { readonly width: number; readonly height: number }) => Region;
    readonly windowBoundsFor: (
        viewport: { readonly width: number; readonly height: number },
        geometry: WindowGeometry,
        screen: { readonly width: number; readonly height: number },
    ) => { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
    readonly readGeometry: (page: Page) => Promise<WindowGeometry | undefined>;
    readonly resizeWindow: (session: CDPSession, bounds: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }) => Promise<void>;
    readonly placeWindow: (context: BrowserContext, page: Page) => Promise<void>;
}

interface DisplayModule {
    readonly DISPLAY_WIDTH: number;
    readonly DISPLAY_HEIGHT: number;
    readonly chromiumWindowArgs: (display: { readonly name: string; readonly width: number; readonly height: number }) => string[];
}

interface ScreencastModule {
    readonly dispatchInput: (session: CDPSession, message: { readonly type: "text"; readonly text: string }) => Promise<void>;
}

interface XInputModule {
    readonly startXInput: (display: { readonly name: string; readonly width: number; readonly height: number }) => {
        readonly move: (x: number, y: number) => void;
        readonly type: (text: string) => void;
        readonly stop: () => void;
    };
}

export interface Daemon {
    readonly videocast: VideocastModule;
    readonly region: RegionModule;
    readonly display: DisplayModule;
    readonly screencast: ScreencastModule;
    readonly xinput: XInputModule;
}

const load = async <T>(file: string): Promise<T> => {
    try {
        // SAFETY: the shape is checked where each member is called; a renamed export fails that call, naming it.
        return (await import(join(CAST, file))) as T;
    } catch (error) {
        throw new Error(`castbench measures the daemon's own ${file}, which did not load from ${CAST} (run castbench from a full checkout, with Bun): ${String(error)}`, { cause: error });
    }
};

export const loadDaemon = async (): Promise<Daemon> => ({
    videocast: await load<VideocastModule>("videocast.ts"),
    region: await load<RegionModule>("region.ts"),
    display: await load<DisplayModule>("display.ts"),
    screencast: await load<ScreencastModule>("screencast.ts"),
    xinput: await load<XInputModule>("xinput.ts"),
});
