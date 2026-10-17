// File formats whose bytes are already compressed (images, audio, video, archives, office documents, fonts): encoding
// them again spends CPU and saves next to nothing. The daemon stores them as they are in a ZIP it streams, and the
// browser sends them plain where it gzips the rest of an upload, so both read the one list here.

const PACKED = new Set(
    (
        "7z aac apk avif br bz2 cab deb docx dmg epub flac gif gz heic heif ico jar jpeg jpg jxl lz lz4 lzma m4a m4v mkv mov mp3 mp4 mpeg mpg " +
        "odg odp ods odt ogg ogv opus pdf png pptx rar rpm tbz tgz txz webm webp whl woff woff2 xlsx xz zip zst"
    ).split(" "),
);

/** Whether a file of this name holds bytes that are already compressed, by its extension. */
export const isPackedName = (name: string): boolean => {
    const base = name.slice(name.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 && PACKED.has(base.slice(dot + 1).toLowerCase());
};
