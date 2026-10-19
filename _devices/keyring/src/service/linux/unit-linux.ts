import { type LinuxServicePaths, POLKIT_ACTION, SERVICE_USER } from "./paths-linux.js";

// What `service install` writes on Linux, as text built here so a test reads it whole: the templated system unit (one
// instance per user, `intentic-keyring@<uid>.service`), the polkit action every yes is asked under, and the argv of the
// commands that put them in place. Nothing in them is secret.

// systemd makes the vault's folder (StateDirectory=, 0700, owned by the service's user) and the door's (RuntimeDirectory=)
// for each instance, and gives the process nothing it does not need: it holds a vault and answers a socket, nothing more.
export const unitText = (paths: Pick<LinuxServicePaths, "exe">): string =>
    `[Unit]
Description=Passwords for user %i (Intentic)
Documentation=https://github.com/intentic/intentic/tree/main/_devices/keyring
After=polkit.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${paths.exe} service run --user %i
Restart=always
RestartSec=5
StateDirectory=intentic-keyring/%i
StateDirectoryMode=0700
RuntimeDirectory=intentic-keyring/%i
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`;

// The polkit action. `auth_self` asks the signed-in person for their own password (or fingerprint) at every check:
// never kept, so each yes is one. polkit fills `$(title)` and `$(message)` from the details the service passes, so its
// dialog says what is asked. The owner annotation lets the service's user ask about the helper, a process of another
// user, which polkit otherwise allows only to root.
export const policyText = (): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>Intentic</vendor>
  <vendor_url>https://intentic.dev</vendor_url>
  <action id="${POLKIT_ACTION}">
    <description>Confirm a request to Passwords</description>
    <message>Passwords asks: $(title). $(message)</message>
    <defaults>
      <allow_any>no</allow_any>
      <allow_inactive>no</allow_inactive>
      <allow_active>auth_self</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.owner">unix-user:${SERVICE_USER}</annotate>
  </action>
</policyconfig>
`;

export const addServiceUserArgs = (): readonly string[] => ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", SERVICE_USER];

export const enableArgs = (paths: Pick<LinuxServicePaths, "unitName">): readonly string[] => ["enable", "--now", paths.unitName];
export const restartArgs = (paths: Pick<LinuxServicePaths, "unitName">): readonly string[] => ["restart", paths.unitName];
export const disableArgs = (paths: Pick<LinuxServicePaths, "unitName">): readonly string[] => ["disable", "--now", paths.unitName];
export const stopArgs = (paths: Pick<LinuxServicePaths, "unitName">): readonly string[] => ["stop", paths.unitName];

// The door opened to the one user it is for (door-linux.ts): its folder may be entered, its socket written, its token
// file read. The service's user owns all three, so it may set their ACLs without root.
export const doorAclArgs = (paths: Pick<LinuxServicePaths, "uid" | "runDir" | "socket" | "door">): readonly (readonly string[])[] => [
    ["-m", `u:${paths.uid}:--x`, paths.runDir],
    ["-m", `u:${paths.uid}:rw-`, paths.socket],
    ["-m", `u:${paths.uid}:r--`, paths.door],
];

/** A user's home and primary group from one `getent passwd` line. Pure. */
export const passwdEntry = (line: string): { readonly uid: number; readonly gid: number; readonly home: string } | undefined => {
    const fields = line.trim().split(":");
    const [uid, gid, home] = [Number(fields[2]), Number(fields[3]), fields[5]];
    return fields.length >= 7 && Number.isInteger(uid) && Number.isInteger(gid) && home !== undefined && home.startsWith("/") ? { uid, gid, home } : undefined;
};

/** Whether another user's `<uid>.installed` marker is left beside `uid`'s: the shared parts stay for them. Pure. */
export const othersInstalledLinux = (rootNames: readonly string[], uid: string): boolean => rootNames.some((name) => name.endsWith(".installed") && name !== `${uid}.installed`);
