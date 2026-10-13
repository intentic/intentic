---
name: instagram
description: Read, comment, reply, like, follow, and publish posts on Instagram as the logged-in user, through a real browser. Use whenever the user asks to do something on Instagram.
---

# Instagram (connected browser)

Feed: https://www.instagram.com  ·  a profile: https://www.instagram.com/<username>/  ·  a post:
https://www.instagram.com/p/<code>/  ·  a reel: https://www.instagram.com/reel/<code>/  ·  messages:
https://www.instagram.com/direct/inbox/

${accounts}

- Read a post and its comments: open its `/p/<code>/` URL directly (from the feed it opens in a modal) and
  `browser_snapshot`; more comments load behind the "+" under the last one.
- Comment: open the post, click "Add a comment…", `browser_type`, then Post.
- Reply to ONE comment: click Reply under that comment (it prefills their @username), type after it, Post.
- Like: click the heart under the post. Double-clicking the image also likes it, so don't double-click by accident.
- Follow: open the profile and click Follow. A private account shows "Requested" until they accept.
- New post: click Create in the sidebar, then Post; "Select from computer" opens a file chooser, answer it with
  `browser_file_upload` and the absolute path of each image or video. Then Next (crop), Next (edit), write the
  caption, Share. There is no text-only post: it needs at least one image or video. Captions stop at 2,200
  characters and 30 hashtags.
- "Save your login info?" and "Turn on notifications" prompts: click "Not now" and carry on.
${tools}
