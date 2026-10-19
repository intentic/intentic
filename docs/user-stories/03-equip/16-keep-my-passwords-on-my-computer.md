# Keep my passwords on my own computer

As someone whose agent works on my own computers as well as in the sandbox, I want my personal passwords to stay on my
computer and be saved as I use them, then handed to an agent only for a use I allow. These are the VPN, SSH and sudo, a
router's admin page, the sites I sign in to, and the program that has no browser. Giving the agent hands on my machine
should not mean giving it my passwords, and none of them should sit in a sandbox that runs other people's code all day.

**Passwords** is an app of its own, with its own tile on the editor's rail. On my computer, in the desktop app, it is the
whole password manager. Its list has search, kinds (websites, apps, terminal, phone, notes), "Agents can use" by sandbox,
and Attention (Just saved, Requests, Weak or reused). Each password shows its user, its value behind a Show or Copy that
asks me first, where it works, which agents may use it and how, what it was used for, and its earlier values. In the
hosted editor the same app shows what that sandbox may use, the requests it is waiting on and what it used, with "Manage
on this computer".

Turning it on is one button. Windows asks once for an administrator's approval (Linux asks through pkexec), because the
vault is held by a service under a system account. No program I run, the agent's commands included, can read it. I
unlock with Windows Hello (polkit on Linux), and every yes is checked by the OS, not by a dialog a program could click
through. I get a recovery key once, to keep somewhere safe. There is one way this works, not a normal mode and a
hardened one.

Then I am asked once to let Intentic remember the passwords I type, source by source:

- **Browsers.** The Intentic extension saves a sign-in when I submit it, and fills it back after my Windows Hello yes.
- **Terminals on my computer.** For an ssh, sudo or git prompt nothing answers yet, Passwords' own box asks me once,
  answers the program and keeps it. git's credential helper saves a sign-in that worked.
- **Apps.** A small "Save with Intentic" chip on a program's password field lets me type it once into Passwords' box,
  which types it into the program and keeps it. Nothing reads keys I type elsewhere.
- **My phone.** The Intentic Device app is Android's autofill service, paired with my computer once.
- **Sandbox terminals.** A password I type at a hidden prompt in a sandbox terminal is kept on my computer.

Saving is quiet: a notice says "Saved github.com · Undo · View". A changed password keeps its old value in its history,
and a failed one is replaced. Adding by hand and importing from a browser, 1Password, Bitwarden or KeePassXC are there
for what was never typed.

An agent asks by need, not by name: `secrets want --site github.com`, or `type_secret` aimed at a page or window. My
computer finds what fits and asks me, naming the sandbox, the place, the account and what it is for: **Allow once**,
**While I'm here**, **Always** (a copy kept in the sandbox, so it works with my computer off) or **Deny**. If I am not
there, the request waits under Requests. The agent then spends it like any other secret, `{{secret:GITHUB_COM}}` in a
command, without ever seeing it.

## Acceptance criteria

- [ ] Passwords is its own rail app in the desktop app and in the hosted editor. This device no longer holds a passwords group
- [ ] Turning it on installs the protected service with one administrator prompt, enrols Windows Hello (polkit on Linux) and shows a recovery key once. There is no per-user or "hardened" mode, and setup on macOS or without administrator rights says why it cannot
- [ ] A value shown, copied, filled or released leaves the vault only after the OS-verified yes of the person at the computer, a sandbox's signed grant under its share's terms, or a paired phone's biometric signature
- [ ] One consent turns on remembering per source (browser, terminal, apps, phone, sandbox), each switchable later. Saving then asks nothing, and shows a notice with Undo
- [ ] A new capture is titled, named (`GITHUB_COM`) and placed (site, program, ssh target) from where it was seen. A changed one keeps its old value in history, a failed one is replaced, a one-time code is never kept, and a never-save place is skipped
- [ ] Captures arriving while locked wait sealed and are taken in at the next unlock
- [ ] An unmatched ssh/sudo/git prompt opens Passwords' type-once box, and git's credential helper stores and answers https sign-ins
- [ ] The browser extension captures sign-ins on submit and fills only entries that serve that site, after a yes
- [ ] A password field in a program on the computer offers "Save/Fill with Intentic", typed through Passwords' own box
- [ ] The Android app saves as the autofill service and fills after the person's biometric, its signature checked against the key pinned at pairing
- [ ] A password typed at a hidden prompt in an editor terminal of the sandbox is kept on the computer that remembers from sandboxes
- [ ] `secrets want` asks the owner's computers by place, and the answer (Allow once / While I'm here / Always / Deny) shares it on those terms. An unanswered request waits under Requests, and nothing about entries that do not match reaches the sandbox
- [ ] Values released into the sandbox are masked in everything the agent reads
- [ ] Two computers' Passwords can be paired with both fingerprints shown on each, and then keep one set of entries through a sandbox that carries only ciphertext
