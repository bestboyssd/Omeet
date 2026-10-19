# Omeet

Omeet is a static video chat site. The public website source is hosted in this repository and published with GitHub Pages. A Cloudflare Worker matches visitors and relays WebRTC connection details; video, audio, and messages travel directly between browsers.

## Use the site

Visit [bestboyssd.github.io/Omeet](https://bestboyssd.github.io/Omeet/). The site asks for camera and microphone access when you start a call. Both people must be online at the same time. Some networks need a TURN relay for peer-to-peer calls to connect reliably.

## Privacy

Omeet processes a visitor's IP address and the gender selected during setup for safety and moderation. Authenticated administrators can review that data, reports, warnings, and bans. The admin dashboard and Worker source are kept in a separate private repository; the admin token and visitor records are held outside GitHub. Read the [privacy notice](privacy.html) before using the site.

Calls and private messages are exchanged directly by the two browsers. Omeet does not record or transcribe them.

## Source layout

- `Omeet.html`, `styles.css`, `script.js`: the public site.
- `config.js`: public connection settings for the Cloudflare Worker.
- `privacy.html`: visitor privacy notice.
- `.github/workflows/pages.yml`: publishes this repository to GitHub Pages.

The admin dashboard and moderation Worker source are not included in this public repository.
