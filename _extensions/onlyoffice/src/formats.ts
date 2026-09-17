// The office formats, by the editor ONLYOFFICE opens them in. The manifest's `extensions` list is this table flattened
// (formats.test.ts holds them together).
export const OFFICE_FORMATS = {
    word: ["docx", "dotx", "docm", "odt", "ott", "rtf", "doc"],
    cell: ["xlsx", "xltx", "xlsm", "ods", "ots", "xls"],
    slide: ["pptx", "potx", "pptm", "odp", "otp", "ppt"],
} as const;

export type DocumentType = keyof typeof OFFICE_FORMATS;

// The lowercased extension of a path, or "" for a dotfile or an extensionless name.
export const extensionOf = (path: string): string => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1) : "";
};

export const documentTypeOf = (extension: string): DocumentType | undefined =>
    (Object.keys(OFFICE_FORMATS) as DocumentType[]).find((type) => (OFFICE_FORMATS[type] as readonly string[]).includes(extension));
