// netdisk: a network disk (SMB share) the sandbox mounts, plus its live mount state.
import { z } from "zod";
// One capability = one mounted share, discriminated by provider so NFS can arrive as its own arm rather than a
// reinterpretation of the SMB fields.
// Whether it is mounted is read from /proc/self/mountinfo, never stored; autoMount is the only persisted intent.
export const NetdiskProviderSchema = z.enum(["smb"]);
export type NetdiskProvider = z.infer<typeof NetdiskProviderSchema>;
// What the container gets over the share. `read` is mounted `ro` AND should be backed by a read-only share account:
// the container holds CAP_SYS_ADMIN, so the mount flag alone stops a mistake, not a determined remount.
export const NetdiskAccessSchema = z.enum(["read", "readwrite"]);
export type NetdiskAccess = z.infer<typeof NetdiskAccessSchema>;
// SMB dialect to insist on; `auto` lets mount.cifs negotiate (3.1.1 down to 2.1). Old NAS firmware may need 1.0.
export const SmbVersionSchema = z.enum(["auto", "3.1.1", "3.0", "2.1", "1.0"]);
export type SmbVersion = z.infer<typeof SmbVersionSchema>;
const autoMount = z.enum(["on", "off"]).default("on");
// A UNC component: no separators, since //server/share is assembled from the parts.
const uncPart = (label: string) =>
    z
        .string()
        .min(1)
        .refine((value) => !/[\\/\s]/.test(value), { message: `${label} is one name, without slashes or spaces.` });
export const SmbNetdiskConfigSchema = z.object({
    provider: z.literal("smb"),
    server: uncPart("Server").describe("The NAS or file server: a hostname or address, reachable from the sandbox (through a VPN if it is behind one)."),
    share: uncPart("Share").describe("The share name, the first path segment after the server in //server/share."),
    // A folder inside the share to mount instead of its root; forward slashes, no leading one.
    path: z
        .string()
        .optional()
        .refine((value) => value === undefined || (!value.startsWith("/") && !value.split("/").includes("..")), {
            message: "Path is a folder inside the share, like projects/2026, with no leading slash and no '..'.",
        })
        .describe("A folder inside the share to mount instead of its root."),
    username: z.string().min(1).describe("The account the sandbox mounts as. For a read-only disk, give it an account the server itself limits to reading."),
    // Absent means a guest share: mount.cifs gets `guest` instead of a credential.
    password: z.string().optional().describe("Its password. Leave empty for a guest share."),
    domain: z.string().optional().describe("The Windows domain or workgroup, only where the server asks for one."),
    access: NetdiskAccessSchema.default("read").describe("Whether the agent may write to it. Read-only is the default."),
    version: SmbVersionSchema.default("auto").describe("The SMB dialect to insist on. Leave on auto unless the server refuses."),
    autoMount,
});
export const NetdiskConfigSchema = z.discriminatedUnion("provider", [SmbNetdiskConfigSchema]);
export type SmbNetdiskConfig = z.infer<typeof SmbNetdiskConfigSchema>;
export type NetdiskConfig = z.infer<typeof NetdiskConfigSchema>;

// Manifest says which disks exist; this says which are mounted. Every field reads live from the OS, so a restart loses
// nothing.
export const NetdiskStateSchema = z.enum([
    // The share is mounted and its files are under mountPoint.
    "mounted",
    // Configured and idle: the normal resting state for a disk nobody asked for.
    "unmounted",
    // mount.cifs isn't installed yet: the capability's image fragment needs an owner-run rebuild.
    "unavailable",
]);
export type NetdiskState = z.infer<typeof NetdiskStateSchema>;
export const NetdiskLinkSchema = z.object({
    id: z.string().describe("Which disk."),
    provider: NetdiskProviderSchema.describe("What protocol it speaks."),
    state: NetdiskStateSchema.describe("Whether it is mounted, resting, or not mountable yet because its client needs a rebuild to arrive."),
    // The UNC path mounted: //server/share/path. Display only, never a credential.
    target: z.string().describe("What it mounts, as //server/share. For display only, and never a credential."),
    mountPoint: z.string().describe("Where its files appear inside the sandbox."),
    access: NetdiskAccessSchema.describe("What the card asked for: read, or read and write."),
    // What the kernel actually enforces on the live mount; absent unless mounted. Disagreeing with `access` is the
    // invariant the daemon patrols.
    writable: z.boolean().optional().describe("Whether the live mount accepts writes, as the kernel has it. Absent unless mounted."),
    // Epoch ms the mount came up; absent unless mounted.
    since: z.number().optional().describe("When it was mounted, in milliseconds. Absent unless it is."),
    autoMount: z.boolean().describe("Whether it mounts itself when the sandbox starts."),
    detail: z.string().optional().describe("Why it is unavailable, or a note about a healthy one. Never a credential."),
});
export type NetdiskLink = z.infer<typeof NetdiskLinkSchema>;
export const NetdiskListSchema = z.object({
    links: z.array(NetdiskLinkSchema).describe("Every configured disk with its live mount state, read back from the kernel each time rather than remembered."),
});
export const NetdiskIdParamSchema = z.object({ id: z.string().describe("Which disk.") });
