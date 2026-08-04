# @intentic/desktop-app

The Windows and Linux desktop app: a window around the editor, and a small program on your machine that can do
the things a web page cannot.

```stats
{ "items": [
    {"label": "TypeScript + Vue", "value": "572", "note": "the app's own screens"},
    {"label": "Rust", "value": "~1.1k", "note": "windows, links, script runner"},
    {"label": "Machine logic", "value": "none", "note": "it runs the shipped scripts"},
    {"label": "Platforms", "value": "Windows · Linux"}
  ] }
```

## The problem it solves

Setting up a sandbox means running a command in a terminal, and that is where people stop. Not because the
command does more than an installer would, but because it arrives with none of an installer's affordances: no
publisher, no preview, no file list, no uninstaller.

The second problem is larger and lasts longer. A sandbox is a container, and a container cannot recreate
itself — the daemon inside it has no access to the machine's Docker. So every time there is a newer sandbox
image, or the owner approves an environment change the agent asked for, the browser can only hand out a
command and ask the user to go and paste it on the right machine. This app is a program **on** that machine,
so those become buttons.

## How it works

One window with two screens, and only one of those screens is native.

```dag
{ "title": "One window, two screens", "direction": "LR",
  "nodes": [
    {"id": "workspace", "label": "Workspace screen", "note": "the hosted web app", "accent": "1"},
    {"id": "shell", "label": "Rust shell", "note": "the frame · tray · links", "accent": "1"},
    {"id": "native", "label": "The app's own screen", "note": "setup, then manager", "accent": "1"},
    {"id": "scripts", "label": "The install scripts", "note": "connect · recreate · cleanup", "accent": "neutral"},
    {"id": "docker", "label": "Docker", "note": "on this machine", "accent": "2"}
  ],
  "edges": [
    {"from": "workspace", "to": "shell"},
    {"from": "shell", "to": "native"},
    {"from": "native", "to": "shell"},
    {"from": "shell", "to": "scripts"},
    {"from": "scripts", "to": "docker"}
  ] }
```

The workspace screen is the ordinary web app, loaded from the internet. It is the same screen a browser shows,
because it *is* that screen — no copy of the interface lives here.

Notice what the arrow from the workspace screen is not: it carries no function calls. Remote content gets no
way to run code in this app. Its only channel is a link starting `intentic://`, which the window recognises
and cancels before it goes anywhere. The same link works from a normal browser too, where the operating system
routes it to the installed app — so a button on a web page can drive this app whether or not the page happens
to be inside it.

That refusal is also why the two screens are separate pieces underneath: permission to run code in the app is
granted per window, so the hosted page and the native screen cannot share one. What the *user* gets is still a
single window. The shell keeps exactly one screen on display and hands the frame over — same place on the
desk, same size — so clicking **Set up on this computer** looks like the window moving on, not like a second
program opening in front of the one being read. It used to be the second thing, and that is where first-time
users stopped.

## The surprising part: it does not know how to install anything

An earlier attempt at this app wrote the machine work in Rust — checking for Docker, installing it, building
the container command, creating the tunnel, starting the sandbox. About fourteen hundred lines, all of it a
second copy of what the install scripts already do. Copies like that drift, this one did, and the experiment
was abandoned.

This version runs the scripts. When you click **Set up on this computer**, it starts the very same
`connect.sh` that the copy-paste command runs — straight away, since you already said so on the page you
clicked it from — reads what the script prints, and shows those lines where the page was. The desktop path and
the terminal path are the same file, so they cannot disagree, and a fix to the script reaches app users with
the app's next release rather than with someone remembering to port it.

The scripts travel inside the app rather than being downloaded, so a given version of the app always contains
the scripts it was built with.

## What the window shows about your machine

Two things, and the second one is newer than the app.

The sandboxes: which containers are here, whether each is running, and the buttons — start, stop, update,
rebuild, remove — that a browser can only ever hand you as a command to paste.

Then **desktop sync**, which this window used to be silent about. The setup it runs configures a folder on
this computer to stay in step with the sandbox, and mirrors the sandbox's dev-server ports onto this
computer's localhost. Having done that, the app never mentioned it again: the folder was passed to the install
script and forgotten, and the only way to see what any of it was doing was a terminal command — in the app
whose entire reason for existing is not needing one.

It now asks the sync agent directly, and shows the same three answers the browser's Computers view shows,
because both read the same report from the same program.

## Signing in happens somewhere else

Google will not let you sign in inside an app window — it refuses on purpose, because a program that draws its
own window could draw a fake Google page in it. Its newer sign-in mechanism also does not exist in the Linux
web engine at all.

So the app does not try. It opens your normal browser, lets you sign in there, and the browser hands the
result back through one of those `intentic://` links. What comes back is a claim ticket, not a credential: the
credentials wait on the server for a single pickup, and the app's window collects them itself over an ordinary
web request. Links are visible to other programs on a computer; a ticket that is already spent is worth
nothing.

## Where it fits

It depends on the design system and nothing else in this repository — the interface it shows belongs to the
web app, which it loads over the network rather than importing.

Installers are published to the same public download shelf as the other programs that run on a user's machine
(the file-sync agent and the connected-computer agent), because this project's release pages are visible only
to members, and the person downloading the app is by definition not one.
