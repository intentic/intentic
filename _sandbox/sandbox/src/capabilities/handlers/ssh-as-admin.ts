// `as-admin`: the one way the agent runs a command as an administrator on a connected machine. The ssh card writes it
// beside the aliases (~/.ssh/intentic-hosts/as-admin) when any machine has an admin password; the agent pipes that
// password in as a reference, `printf '%s\n' '{{secret:<alias>/adminPassword}}' | as-admin <alias> '<command>'`, so the
// value is filled in at execution and never read.
//
// Whose password it is (`<alias>.admin`, "user" or "root") decides how it is typed:
//   - user: `sudo -S`, which reads it from stdin, no terminal needed.
//   - root: `su`, which reads only from a terminal and flushes whatever was typed before it asked (PAM's misc_conv sets
//     TCSAFLUSH), so the password can neither be piped ahead nor typed the instant the prompt shows. The remote side
//     gets a terminal (`ssh -tt`), prints a marker first so a sign-in prompt before it is never mistaken for su's, and
//     the password goes in a moment after su's prompt. That terminal joins stderr into stdout and ends lines with CRLF,
//     which are put back to LF.
// A password-auth machine signs in through sshpass with its `.pass` file, as the skill's own commands do. Python, which
// the sandbox image carries, for its pty-free pipes and select; the remote machine needs nothing but sh and sudo or su.
export const AS_ADMIN_SCRIPT = `#!/usr/bin/env python3
"""as-admin <alias> <command>: run <command> as root on <alias>; the admin password comes in on stdin."""
import os, select, shlex, subprocess, sys, time

HOSTS = os.path.dirname(os.path.realpath(__file__))
MARK = b"__intentic_as_admin__"

if len(sys.argv) != 3:
    sys.exit("usage: printf '%s\\\\n' '{{secret:<alias>/adminPassword}}' | as-admin <alias> '<command>'")
alias, command = sys.argv[1], sys.argv[2]
try:
    whose = open(os.path.join(HOSTS, alias + ".admin")).read().strip()
except FileNotFoundError:
    sys.exit(f"as-admin: {alias} has no admin password on its SSH card; ask the owner to add one there")
password = sys.stdin.readline().rstrip("\\n")
if password == "":
    sys.exit("as-admin: no password on stdin")

ssh = ["ssh"]
pass_file = os.path.join(HOSTS, alias + ".pass")
if os.path.exists(pass_file):
    ssh = ["sshpass", "-f", pass_file, "ssh"]

if whose == "user":
    remote = "sudo -S -p '' sh -c " + shlex.quote(command)
    done = subprocess.run(ssh + [alias, remote], input=(password + "\\n").encode())
    sys.exit(done.returncode)

remote = "echo " + MARK.decode() + "; exec su root -c " + shlex.quote(command)
proc = subprocess.Popen(ssh + ["-tt", alias, remote], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
out = proc.stdout.fileno()
seen, sent, fresh = b"", False, True
while True:
    ready, _, _ = select.select([out], [], [], 60 if not sent else None)
    if not ready:
        proc.kill()
        sys.exit("as-admin: su never asked for a password")
    data = os.read(out, 65536)
    if not data:
        break
    if sent:
        if fresh:
            # The line su ends its prompt with, once echo is back on.
            data, fresh = data.removeprefix(b"\\r\\n"), False
        sys.stdout.buffer.write(data.replace(b"\\r\\n", b"\\n"))
        sys.stdout.flush()
        continue
    seen += data
    at = seen.find(MARK)
    if at >= 0 and b"assword" in seen[at:]:
        # su prints its prompt a moment before it turns echo off, and that switch drops what was typed before it.
        time.sleep(0.3)
        proc.stdin.write((password + "\\n").encode())
        proc.stdin.flush()
        sent, seen = True, b""
proc.stdin.close()
sys.exit(proc.wait())
`;
