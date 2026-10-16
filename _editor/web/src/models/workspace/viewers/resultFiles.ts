import { sandboxBlob } from "../../../client/sandbox/sandboxClient";
import { basename } from "@intentic/ui/path";

export const readResult = (id: string, path: string, at?: string): Promise<Blob> =>
    sandboxBlob(`/agents/${encodeURIComponent(id)}/documents/raw?${new URLSearchParams({ path })}`, undefined, at);

export const saveResult = async (id: string, path: string, at?: string): Promise<void> => {
    const url = URL.createObjectURL(await readResult(id, path, at));
    const link = document.createElement(`a`);
    link.href = url;
    link.download = basename(path);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
