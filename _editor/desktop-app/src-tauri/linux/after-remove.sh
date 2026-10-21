#!/bin/sh
# AFTER THE PACKAGE IS REMOVED (tauri.conf.json: the deb's postrm and the rpm's %postun, 2026-10-21).
#
# Removing the package is how an app comes off Linux, so it is the one way to remove the Intentic app there, as Windows'
# own uninstaller is on a PC. A package's scripts run as root and keep out of people's home folders, and Intentic's
# sandboxes, its machine agent and folder sync are each user's own: what goes with them is that user's choice, made in
# `ic uninstall`, which shows what is here and offers the same two choices the Windows uninstaller does. So this only
# says what stays and the one command that removes it.
#
# deb: $1 is remove, purge, upgrade, failed-upgrade, abort-install, abort-upgrade or disappear.
# rpm: $1 is how many copies are still installed: 0 when the package is erased, 1 or more during an upgrade.
case "$1" in
remove | 0) ;;
*) exit 0 ;;
esac

cat <<'EOF'

The Intentic app is removed.

Your sandboxes, the machine agent that keeps them running, folder sync and saved
passwords were set up for your user, so they stay. To see what is left and remove
it (you choose whether your sandboxes stay), run as yourself, not as root:

    curl -fsSL https://intentic.dev/uninstall | sh

EOF
exit 0
