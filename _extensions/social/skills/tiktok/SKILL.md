---
name: tiktok
description: Watch/read, comment, reply, like, follow, and upload videos on TikTok as the logged-in user, through a real browser. Use whenever the user asks to do something on TikTok.
---

# TikTok (connected browser)

For You: https://www.tiktok.com  ·  a profile: https://www.tiktok.com/@<handle>  ·  a video:
https://www.tiktok.com/@<handle>/video/<id>  ·  upload: https://www.tiktok.com/tiktokstudio/upload

${accounts}

- Read a video and its comments: open the video's own URL, then `browser_snapshot`; the comments sit in the side
  panel and load as it scrolls. Prefer a video's URL over the For You feed, which autoplays and keeps moving under
  a snapshot.
- Comment: open the video, click "Add comment…", `browser_type`, then Post. A comment holds 150 characters at most.
- Reply to ONE comment: click Reply under that comment so yours nests beneath it.
- Like: click the heart beside the video. Follow: click Follow on the profile or beside the video.
- Upload: open the upload page, click "Select video" and answer the file chooser with `browser_file_upload` and the
  video's absolute path. Wait for processing to finish, write the description (hashtags and @mentions inline),
  check who can watch it, then Post.
- TikTok puts a slider puzzle in front of sign-ins and sometimes mid-session. It is a person's to solve: hand it to
  the owner with `mcp__accounts__request_help`.
${tools}
