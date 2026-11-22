import { z } from "zod";

/** A normalized, workspace-relative folder path. Scopes are hints for the checkout, not a security boundary. */
const workspacePath = z.string().min(1).refine((path) => {
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
        return false;
    }
    const segments = path.split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Use a normalized workspace-relative folder path without `.` or `..` segments.");

export const workspacePaths = z.array(workspacePath).min(1).max(50).optional();
