// TikTok in Firefox follows you in picture-in-picture. Firefox's autoconfig (mozilla.cfg) loads
// this from its autoconfig.d/tiktok-pip folder at startup (see ../mozilla.cfg).
// - TikTok goes to PiP when its tab stops showing (another tab, Firefox minimized, on another
//   desktop or fully covered), but only while a video plays. The same PiP window stays while you
//   move around, and closes when you're back on the TikTok tab. Right-click the TikTok tab (or the
//   page) to turn that off or on.
// - The PiP window: ▲ ▼ buttons, ↑/↓ while it has focus and two-finger swipes go to the
//   previous/next TikTok, and the window keeps showing whichever video plays
//   (TikTokPipChild.sys.mjs). Its controls only show when you click it, and a thin progress bar
//   runs along the bottom, as on TikTok.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
});

const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
const XHTML = "http://www.w3.org/1999/xhtml";
const ENABLED_PREF = "tiktok-pip.enabled";
// Minimizing, desktop switches and covering windows come through as occlusion; wait out quick
// flips (the overview, a window passing over) before opening a PiP.
const HIDE_DELAY_MS = 300;
// Firefox hears 2-4 s late that its window went to another desktop or was minimized; PiP
// Everywhere (GNOME Shell) writes it here at once. Read while Firefox isn't the active window.
const SHELL_FILE = PathUtils.join(Services.env.get("XDG_RUNTIME_DIR") || "/nonexistent",
  "pip-everywhere", "hidden-windows.json");
const SHELL_POLL_MS = 200;
// How far two fingers (or the wheel) move before it counts as a swipe to the next TikTok.
const SWIPE_PX = 60;
// A swipe ends when the touchpad has been quiet this long (its momentum included).
const SWIPE_END_MS = 250;

let tiktok;
// Titles of Firefox windows GNOME Shell says are on another desktop or minimized.
let shellHidden = new Set();

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
  Services.obs.addObserver(win => {
    watchWindow(win);
    addMenus(win);
  }, "browser-delayed-startup-finished");
  Services.obs.addObserver(win => {
    win.addEventListener("DOMContentLoaded", () => {
      if (win.location.href === PLAYER_URL) decoratePlayer(win);
    }, { once: true });
  }, "chrome-document-global-created");
}

function isTikTok(browser) {
  return !!browser?.currentURI && !!tiktok?.matches(browser.currentURI);
}

const enabled = () => Services.prefs.getBoolPref(ENABLED_PREF, true);

function send(browser, name, data) {
  try {
    browser.browsingContext.currentWindowGlobal.getActor("TikTokPip").sendAsyncMessage(`TikTokPip:${name}`, data);
  } catch (e) {
    // The page is between loads, or not TikTok anymore.
  }
}

async function readShellHidden() {
  try {
    shellHidden = new Set(JSON.parse(await IOUtils.readUTF8(SHELL_FILE)).hidden ?? []);
  } catch (e) {
    // No PiP Everywhere: only Firefox's own (later) news.
    shellHidden = new Set();
  }
}

// The tab you can see in a browser window: its selected tab, unless the window is minimized,
// fully covered or on another desktop.
function shownBrowser(win) {
  if (win.closed || win.isFullyOccluded || win.windowState === win.STATE_MINIMIZED) return null;
  if (Services.focus.activeWindow !== win && shellHidden.has(win.document.title)) return null;
  return win.gBrowser.selectedBrowser;
}

function watchWindow(win) {
  let shown = shownBrowser(win);
  let timer = null;
  let poll = null;
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
    if (isTikTok(before) && enabled()) send(before, "Leave");
    if (isTikTok(now)) send(now, "Back");
  };
  win.gBrowser.tabContainer.addEventListener("TabSelect", () => update());
  win.addEventListener("occlusionstatechange", () => update(true));
  win.addEventListener("sizemodechange", () => update(true));
  // Not the active window: maybe on another desktop or minimized. Ask GNOME Shell while TikTok
  // is the selected tab.
  const watchShell = () => {
    win.clearTimeout(poll);
    if (Services.focus.activeWindow === win || !isTikTok(win.gBrowser.selectedBrowser) || win.closed) return;
    readShellHidden().then(() => {
      update();
      poll = win.setTimeout(watchShell, SHELL_POLL_MS);
    });
  };
  win.addEventListener("deactivate", watchShell);
  win.gBrowser.tabContainer.addEventListener("TabSelect", watchShell);
  // The selected tab going to TikTok
  win.gBrowser.addProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    onLocationChange: watchShell,
  });
  win.addEventListener("activate", () => {
    win.clearTimeout(poll);
    update();
  });
  watchShell();
}

// "Picture-in-picture when you leave TikTok", ticked or not, when you right-click the TikTok tab
// or the page (TikTok's videos have a menu of their own).
function addMenus(win) {
  const doc = win.document;
  for (const [menuId, browserOf] of [
    ["tabContextMenu", () => win.TabContextMenu.contextTab?.linkedBrowser],
    ["contentAreaContextMenu", () => win.gContextMenu?.browser],
  ]) {
    const menu = doc.getElementById(menuId);
    if (!menu) continue;
    const separator = doc.createXULElement("menuseparator");
    const item = doc.createXULElement("menuitem");
    item.id = `${menuId}-tiktok-pip`;
    item.setAttribute("type", "checkbox");
    item.setAttribute("label", "Picture-in-picture when you leave TikTok");
    item.addEventListener("command", () => Services.prefs.setBoolPref(ENABLED_PREF, !enabled()));
    menu.append(separator, item);
    menu.addEventListener("popupshowing", e => {
      if (e.target !== menu) return;
      const show = isTikTok(browserOf());
      separator.hidden = item.hidden = !show;
      item.setAttribute("checked", enabled());
    });
  }
}

// The ▲ ▼ buttons, ↑/↓, swipes, controls on click and the progress bar, only when the video comes
// from TikTok.
function decoratePlayer(win) {
  const doc = win.document;
  const root = doc.documentElement;
  const link = doc.createElementNS(XHTML, "link");
  link.rel = "stylesheet";
  link.href = "resource://tiktok-pip/player.css";
  doc.head.appendChild(link);

  const isTikTokPlayer = () => root.hasAttribute("tiktok");
  const source = () => lazy.PictureInPicture.weakWinToBrowser.get(win);
  const go = dir => {
    const browser = source();
    if (isTikTok(browser)) send(browser, "Go", { dir });
  };
  const controls = doc.getElementById("controls");
  for (const [dir, label] of [["prev", "Previous video"], ["next", "Next video"]]) {
    const button = doc.createElementNS(XHTML, "button");
    button.id = `tiktok-${dir}`;
    button.className = "control-item control-button tiktok-pip-nav";
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
    if (!isTikTokPlayer() || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (["scrubber", "audio-scrubber"].includes(e.target?.id)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    go(e.key === "ArrowDown" ? "next" : "prev");
  }, true);

  // Two fingers up (or the wheel down): next TikTok, like scrolling the feed. One per swipe.
  let travel = 0;
  let swiped = false;
  let quiet = null;
  win.addEventListener("wheel", e => {
    if (!isTikTokPlayer() || ["scrubber", "audio-scrubber"].includes(e.target?.id)) return;
    e.preventDefault();
    win.clearTimeout(quiet);
    quiet = win.setTimeout(() => {
      travel = 0;
      swiped = false;
    }, SWIPE_END_MS);
    if (swiped) return;
    travel += e.deltaMode === e.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * 40;
    if (Math.abs(travel) >= SWIPE_PX) {
      swiped = true;
      go(travel > 0 ? "next" : "prev");
    }
  }, { capture: true, passive: false });

  // Controls only after a click on the video; another click, or the pointer leaving, hides them.
  win.addEventListener("click", e => {
    if (!isTikTokPlayer()) return;
    if (root.hasAttribute("tiktok-controls") && e.target.closest?.("button, input, .panel")) return;
    root.toggleAttribute("tiktok-controls");
  }, true);
  root.addEventListener("mouseleave", () => root.removeAttribute("tiktok-controls"));

  // TikTok's thin progress bar. The player hears the position a few times a second.
  const bar = doc.createElementNS(XHTML, "div");
  bar.id = "tiktok-progress";
  const fill = doc.createElementNS(XHTML, "div");
  bar.appendChild(fill);
  doc.body.appendChild(bar);
  let last = 0;
  const setScrubberPosition = win.setScrubberPosition;
  win.setScrubberPosition = position => {
    setScrubberPosition(position);
    const p = Number.isFinite(position) ? position : 0;
    // Back to the start (the video looped, or another one): jump, don't slide back.
    fill.classList.toggle("jump", p < last);
    fill.style.width = `${p * 100}%`;
    last = p;
  };

  // The player learns its source tab only after it has loaded.
  let tries = 0;
  const mark = () => {
    const browser = source();
    if (browser) {
      root.toggleAttribute("tiktok", isTikTok(browser));
      root.setAttribute("source-known", "");
    } else if (++tries < 50) {
      win.setTimeout(mark, 100);
    } else {
      root.setAttribute("source-known", "");
    }
  };
  win.addEventListener("load", mark, { once: true });
}
