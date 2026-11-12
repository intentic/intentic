/* The downloads API, declared by hand beside chrome-api.d.ts (which this merges into). Present only while the extension
   holds the optional `downloads` permission, turned on from the popup, so it is typed as possibly absent and read that
   way everywhere (background/tools/media-downloads.ts). */

declare namespace chrome {
    type DownloadState = "in_progress" | "interrupted" | "complete";
    interface DownloadItem {
        id: number;
        // Where the download came from: for a page's own Blob, a `blob:<origin>/<uuid>` address.
        url: string;
        finalUrl?: string;
        // The page that started it, when Chrome knows one; empty for a blob the page saved itself.
        referrer?: string;
        // The absolute path on disk once Chrome has chosen it.
        filename: string;
        mime?: string;
        state: DownloadState;
        fileSize?: number;
    }
    interface DownloadDelta {
        id: number;
        state?: { current?: DownloadState; previous?: DownloadState };
        error?: { current?: string };
    }
    interface DownloadsApi {
        search(query: { id?: number }): Promise<DownloadItem[]>;
        cancel(id: number): Promise<void>;
        // Deletes the file on disk; `erase` then drops it from the browser's own download list.
        removeFile(id: number): Promise<void>;
        erase(query: { id?: number }): Promise<number[]>;
        onCreated: { addListener: (callback: (item: DownloadItem) => void) => void };
        onChanged: { addListener: (callback: (delta: DownloadDelta) => void) => void };
    }
    const downloads: DownloadsApi | undefined;
}
