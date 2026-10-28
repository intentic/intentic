// Types for dev-previews.mjs, the records of long-lived dev previews (the demo's per-conversation dev servers).
export interface PreviewRecord {
    readonly v: 1;
    readonly conversation: string;
    readonly label: string;
    readonly pid: number;
    readonly startTicks: string;
    readonly pidNamespace: string;
    readonly port: number;
    readonly url: string;
    readonly root: string;
    readonly log: string;
    readonly startedAt: number;
    readonly lastActiveAt: number;
}

export interface EndedNote {
    readonly reason: string;
    readonly at: number;
}

export const PREVIEWS_DIR_ENV: string;
export const DEFAULT_PREVIEWS_DIR: string;
export const OWNER_ENV: string;
export const RECORD_ENV: string;
export const PREVIEW_PORTS: { readonly first: number; readonly last: number };
export const PREVIEW_CAP: number;
export const PREVIEW_IDLE_MS: number;
export const TOUCH_EVERY_MS: number;

export function previewsDir(env?: Readonly<Record<string, string | undefined>>): string;
export function recordName(conversation: string, label: string): string;
export function recordPath(dir: string, conversation: string, label: string): string;
export function openPreviewLog(dir: string, conversation: string, label: string): { readonly path: string; readonly fd: number };
export function hostLabel(conversation: string): string;
export function startTicksOf(pid: number, procRoot?: string): string | undefined;
export function ownerOf(pid: number, procRoot?: string): string | undefined;
export function pidNamespaceOf(pid?: number | "self", procRoot?: string): string;
export function parseRecord(text: string): PreviewRecord | undefined;
export function recordIsOurs(record: PreviewRecord, procRoot?: string): boolean;
export function recordIsLive(record: PreviewRecord, procRoot?: string): boolean;
export function readRecords(dir?: string, procRoot?: string): PreviewRecord[];
export function writeRecord(dir: string, record: PreviewRecord): string;
export function touchRecord(path: string, at?: number): PreviewRecord | undefined;
export function removeRecord(dir: string, record: PreviewRecord): void;
export function noteStop(dir: string, record: PreviewRecord, reason: string): void;
export function stopReason(dir: string, record: PreviewRecord): string | undefined;
export function endedNote(dir: string, conversation: string, label: string): EndedNote | undefined;
export function clearEnded(dir: string, conversation: string, label: string): void;
export function overCap(records: readonly PreviewRecord[], cap?: number): PreviewRecord[];
export function idleRecords(records: readonly PreviewRecord[], now?: number, idleMs?: number): PreviewRecord[];
export function stopPreview(
    dir: string,
    record: PreviewRecord,
    reason: string,
    options?: { readonly graceMs?: number; readonly procRoot?: string },
): Promise<void>;
export function preferredPort(conversation: string): number;
export function freePreviewPort(taken?: ReadonlySet<number>, from?: number, isFree?: (port: number) => Promise<boolean>): Promise<number | undefined>;
