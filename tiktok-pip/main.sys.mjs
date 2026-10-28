// TikTok in Firefox follows you in picture-in-picture. Firefox's autoconfig (mozilla.cfg) loads
// this from its autoconfig.d/tiktok-pip folder at startup (see ../mozilla.cfg).
// - TikTok goes to PiP when its tab stops showing (another tab, Firefox minimized, on another
//   desktop or fully covered), but only while a video plays. The same PiP window stays while you
//   move around, and closes when you're back on the TikTok tab.
// - The PiP window gets ▲ ▼ buttons, and ↑/↓ while it has focus, to go to the previous/next
//   TikTok; the window keeps showing whichever video plays (TikTokPipChild.sys.mjs).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
});

const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
// Minimizing, desktop switches and covering windows come through as occlusion; wait out quick
// flips (the overview, a window passing over) before opening a PiP.
const HIDE_DELAY_MS = 300;

let tiktok;

export function init() {
  // mozilla.cfg runs before the profile's prefs are read; this comes after, before any window.
  Services.obs.addObserver(function register() {
    Services.obs.removeObserver(register, "final-ui-startup");
    // Tests point this at a local copy of TikTok's feed.
    const matches = Services.prefs.getStringPref("tiktok-pip.matches", "*://*.tiktok.com/*").split(",");
    tiktok = new MatchPatternSet(matches);
    ChromeUtils.registerWindowActor("TikTokPip", {
      parent: { esModuleURI: "resource://tiktok-pip/TikTokPipParent.sys.mjs" },
      child: {
        esModuleURI: "resource://tiktok-pip/TikTokPipChild.sys.mjs",
        // Created with the page, before TikTok's own scripts, so its listeners run first.
        events: { DOMWindowCreated: {} },
      },
      matches,
      // Firefox only lets actors into web pages with this.
      safeForUntrustedWebProcess: true,
    });
  }, "final-ui-startup");
  // Browser windows have their tabs (gBrowser) once they've started up.
  Services.obs.addObserver(watchWindow, "browser-delayed-startup-finished");
  Services.obs.addObserver(win => {
    win.addEventListener("DOMContentLoaded", () => {
      if (win.location.href === PLAYER_URL) decoratePlayer(win);
    }, { once: true });
  }, "chrome-document-global-created");
}

function isTikTok(browser) {
  return !!browser?.currentURI && !!tiktok?.matches(browser.currentURI);
}

function send(browser, name, data) {
  try {
    browser.browsingContext.currentWindowGlobal.getActor("TikTokPip").sendAsyncMessage(`TikTokPip:${name}`, data);
  } catch (e) {
    // The page is between loads, or not TikTok anymore.
  }
}

// The tab you can see in a browser window: its selected tab, unless the window is minimized,
// fully covered or on another desktop.
function shownBrowser(win) {
  if (win.closed || win.isFullyOccluded || win.windowState === win.STATE_MINIMIZED) return null;
  return win.gBrowser.selectedBrowser;
}

function watchWindow(win) {
  let shown = shownBrowser(win);
  let timer = null;
  const update = (delayHide = false) => {
    win.clearTimeout(timer);
    const now = shownBrowser(win);
    if (now === shown) return;
    if (!now && delayHide) {
      timer = win.setTimeout(() => update(), HIDE_DELAY_MS);
      return;
    }
    const before = shown;
    shown = now;
    if (isTikTok(before)) send(before, "Leave");
    if (isTikTok(now)) send(now, "Back");
  };
  win.gBrowser.tabContainer.addEventListener("TabSelect", () => update());
  win.addEventListener("occlusionstatechange", () => update(true));
  win.addEventListener("sizemodechange", () => update(true));
}

// The ▲ ▼ buttons and ↑/↓ keys, only shown when the video comes from TikTok.
function decoratePlayer(win) {
  const doc = win.document;
  const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
  link.rel = "stylesheet";
  link.href = "resource://tiktok-pip/player.css";
  doc.head.appendChild(link);

  const source = () => lazy.PictureInPicture.weakWinToBrowser.get(win);
  const go = dir => {
    const browser = source();
    if (isTikTok(browser)) send(browser, "Go", { dir });
  };
  const controls = doc.getElementById("controls");
  for (const [dir, label] of [["prev", "Previous video (↑)"], ["next", "Next video (↓)"]]) {
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.id = `tiktok-${dir}`;
    button.className = "control-item control-button inline-start-tooltip tiktok-pip-nav";
    button.setAttribute("tooltip", label);
    button.setAttribute("aria-label", label);
    button.addEventListener("click", e => {
      e.stopPropagation();
      go(dir);
    });
    controls.appendChild(button);
  }

  // Before the player's own handler, which turns ↑/↓ into volume. On the volume or time
  // sliders they keep doing what they do there.
  win.addEventListener("keydown", e => {
    if (!doc.documentElement.hasAttribute("tiktok") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (["scrubber", "audio-scrubber"].includes(e.target?.id)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    go(e.key === "ArrowDown" ? "next" : "prev");
  }, true);

  // The player learns its source tab only after it has loaded.
  let tries = 0;
  const mark = () => {
    const browser = source();
    if (browser) doc.documentElement.toggleAttribute("tiktok", isTikTok(browser));
    else if (++tries < 50) win.setTimeout(mark, 100);
  };
  win.addEventListener("load", mark, { once: true });
}
