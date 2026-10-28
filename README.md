<p align="center"><img src="logo.svg" width="110" alt="TikTok PiP logo"></p>

<h1 align="center">TikTok PiP for Firefox</h1>

<p align="center">TikTok follows you in picture-in-picture: it pops out when you leave the tab,<br>
switches videos with ↑ ↓, and goes back into the page when you return.</p>

<p align="center"><img src="docs/tiktok-pip.svg" alt="1. Leave TikTok: the video floats over another tab. 2. Up and down arrows switch videos in the floating window. 3. Back on TikTok: the window closes and the video plays in the page"></p>

## The problem

Firefox's picture-in-picture is made for one long video. TikTok is a feed of short ones, each
with its own player, so it doesn't fit:

- you have to open it by hand every time;
- it stops when TikTok moves on to the next video;
- there's no way to move to the next video from the picture-in-picture window.

TikTok also pauses as soon as its tab is hidden.

## What it does

- **Pops out by itself.** When the TikTok tab stops showing, the playing video goes to
  picture-in-picture. That happens when you:
  - switch to another tab;
  - minimize Firefox;
  - move to another desktop;
  - cover Firefox with another window.

  A paused video stays put, and the PiP window never takes your keyboard focus.
- **One window that stays.** Moving between tabs and desktops keeps the same window. It never
  closes and reopens.
- **Swipe or ↑ ↓ to switch videos.** Over the window:
  - a two-finger swipe up goes to the next TikTok, and down to the previous one (or the mouse
    wheel);
  - or click it, then press ↓ / ↑, as on TikTok itself.

  The window follows to the new video, and the TikTok tab moves along with it. ← → still jump 5
  seconds.
- **Clean window.** Firefox's controls and the ▲ ▼ buttons only show when you click the video,
  and hide again on the next click or when the pointer leaves. There are no tooltips. A thin grey
  bar along the bottom fills up in red as the video plays, as on TikTok.
- **Back to the page.** Select the TikTok tab again and the window closes, while the video keeps
  playing in the page.
- **On or off.** Right-click the TikTok tab, or the TikTok page outside a video (videos have
  TikTok's own menu), and untick **Picture-in-picture when you leave TikTok**. Firefox remembers
  the choice.

Some details:
- Closing the window with ✕ pauses the video, as usual, so nothing pops up again until you
  press play.
- A picture-in-picture you open yourself while watching stays open until you've left TikTok and
  come back.
- Other sites aren't affected.

On GNOME, pair it with [PiP Everywhere](https://github.com/aimanelahssini/gnome-pip-everywhere).
With it:
- the window stays on top on every desktop and appears without the zoom-in;
- it comes back where you last put it, at the same size;
- the video pops out the moment you change desktop or minimize Firefox. Otherwise Firefox only
  hears about it 2-4 seconds later.

## Install

Needs Firefox from your distribution's package (`/usr/lib64/firefox` or `/usr/lib/firefox`;
not the Flatpak or Snap). Tested with Firefox 158.

```bash
git clone https://github.com/aimanelahssini/firefox-tiktok-pip
cd firefox-tiktok-pip
./install.sh
```

It asks for your password, because the files go into Firefox's own folder. Then restart Firefox.
Running `./install.sh` again after a `git pull` updates it, and asks for the password only if
something changed.

## How it works

Firefox runs a file called `mozilla.cfg` from its folder at startup ("autoconfig"). The installer
puts `tiktok-pip/` into Firefox's `autoconfig.d/` folder and adds a small loader to
`mozilla.cfg`. A `mozilla.cfg` from someone else is never changed. The code then uses Firefox's
own picture-in-picture: the parts that open, close and redraw the window. Package updates leave
these files alone.

Nothing is sent anywhere, and it never reads or changes your TikTok account. It only clicks
TikTok's own previous/next buttons.

TikTok changes its site from time to time. If ↑ ↓ stop working, please open an issue.

## Uninstall

```bash
./uninstall.sh
```

Then restart Firefox.

## Tests

- `node tests/tiktok-pip.test.mjs`: 46 checks on a private copy of the system Firefox (a btrfs
  reflink, so it costs no space), against a stand-in for TikTok's feed.
- `tests/desktops.sh`: other desktops, minimizing and covering windows, and PiP Everywhere's part,
  in a throwaway headless GNOME Shell.
- `COOKIES=… node tests/real-tiktok.mjs`: a check against the real, logged-in TikTok. COOKIES is
  a copy of a Firefox `cookies.sqlite` holding only tiktok.com cookies; the test profile is
  deleted afterwards. Set `tiktok-pip.debug` to `true` in `about:config` to see what it does on
  Firefox's standard output.
- `tests/install.test.sh`: the installer, on fake Firefox folders.

The tests need `node`, `ffmpeg` and, for `desktops.sh`, GNOME Shell.

## License

MIT
