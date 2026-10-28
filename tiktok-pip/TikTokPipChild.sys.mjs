// The TikTok page's side of main.sys.mjs: opens and closes the picture-in-picture, moves to the
// previous/next TikTok, and keeps the open PiP window on whichever video plays.

import { getActorFor } from "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs";
import { clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

// TikTok pauses its video when the tab goes hidden: a pause this soon after is TikTok's, and the
// video still counts as playing for JUST_PAUSED_MS.
const HIDDEN_PAUSE_MS = 500;
const JUST_PAUSED_MS = 2000;
// about:config tiktok-pip.debug = true: what it does, on Firefox's standard output.
const debug = (...args) => {
  if (Services.prefs.getBoolPref("tiktok-pip.debug", false)) dump(`tiktok-pip: ${args.join(" ")}\n`);
};

export class TikTokPipChild extends JSWindowActorChild {
  // PiP opened or kept while TikTok wasn't showing; closed again when it is.
  #away = false;
  #hiddenAt = 0;
  // TikTok wasn't told its tab went hidden.
  #heldBack = false;
  #pausedVideo = null;
  #pausedAt = 0;
  // The video in the PiP window. TikTok sometimes takes it out of the page while it plays.
  #pip = null;
  // Videos we moved an open PiP to; Firefox only knows the first one.
  #pipActors = new WeakMap();

  handleEvent(event) {
    if (event.type !== "DOMWindowCreated") return;
    const win = this.contentWindow;
    // TikTok pauses when its tab is hidden. While a video plays it's about to go to PiP, so
    // TikTok doesn't hear about it (window capture runs before the page's listeners).
    // The "visible" that follows is held back too: to TikTok, coming back from a tab it never left
    // looks like a return to the page, and it reloads the feed.
    win.addEventListener("visibilitychange", e => {
      if (this.document.hidden) {
        this.#hiddenAt = Date.now();
        this.#heldBack = !!this.#playingVideo();
      } else if (!this.#heldBack) {
        return;
      } else {
        this.#heldBack = false;
      }
      if (this.document.hidden ? this.#heldBack : true) e.stopImmediatePropagation();
    }, true);
    win.addEventListener("pause", e => {
      if (!this.document.hidden || Date.now() - this.#hiddenAt > HIDDEN_PAUSE_MS) return;
      this.#pausedVideo = e.target;
      this.#pausedAt = Date.now();
    }, true);
    win.addEventListener("play", e => {
      this.#pausedVideo = null;
      this.#follow(e.target);
    }, true);
  }

  receiveMessage(message) {
    switch (message.name) {
      case "TikTokPip:Leave":
        this.#leave();
        break;
      case "TikTokPip:Back":
        this.#back();
        break;
      case "TikTokPip:Go":
        this.#go(message.data.dir);
        break;
    }
  }

  #videos() {
    return [...this.document.querySelectorAll("video")];
  }

  // TikTok's current video: the playing one that takes the most of the screen (TikTok also plays
  // hidden and small ones, like LIVE previews).
  #playingVideo() {
    const win = this.contentWindow;
    const shown = v => {
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, win.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0);
      return w > 0 && h > 0 ? w * h : 0;
    };
    return this.#videos().filter(v => !v.paused && !v.ended && shown(v) > 0).sort((a, b) => shown(b) - shown(a))[0];
  }

  // The open PiP window of this page: the video it shows (or last showed), its Firefox actor and
  // the window's own <video>. TikTok reuses its <video> elements for other posts, and Firefox stops
  // copying one when that happens, so the window can be open while nothing is copied into it.
  #pipWindow() {
    if (!this.#playerOf(this.#pip))
      this.#pip = this.#videos().find(v => v.isCloningElementVisually) ?? null;
    const playerVideo = this.#playerOf(this.#pip);
    if (!playerVideo) {
      this.#pip = null;
      return null;
    }
    return { video: this.#pip, actor: this.#pipActor(this.#pip), playerVideo };
  }

  #playerOf(video) {
    try {
      return (video && this.#pipActor(video)?.document?.getElementById("playervideo")) ?? null;
    } catch (e) {
      // That PiP window is closed.
      return null;
    }
  }

  #pipActor(video) {
    return getActorFor(video) ?? this.#pipActors.get(video);
  }

  #leave() {
    if (this.#pipWindow()) {
      // Already in PiP (opened by hand): it stays, and now closes when you're back.
      this.#away = true;
      this.sendAsyncMessage("TikTokPip:Opened");
      return;
    }
    let video = this.#playingVideo();
    if (!video && this.#pausedVideo?.isConnected && Date.now() - this.#pausedAt < JUST_PAUSED_MS) {
      video = this.#pausedVideo;
      video.play();
    }
    debug(`leave: ${video ? `PiP on ${video.currentSrc.slice(-12)}` : "nothing playing"}`);
    if (!video) return;
    this.#away = true;
    this.#pip = video;
    // Same as Firefox's own "PiP when switching tabs", which doesn't take focus.
    this.contentWindow.windowGlobalChild.getActor("PictureInPictureLauncher")
      .togglePictureInPicture({ video, reason: "AutoPip" }, false)
      .then(() => {
        debug(`opened: cloning ${video.isCloningElementVisually}, in page ${video.isConnected}, actor ${!!getActorFor(video)}`);
        this.sendAsyncMessage("TikTokPip:Opened");
      });
  }

  #back() {
    if (!this.#away) return;
    this.#away = false;
    this.#pipWindow()?.actor.closePictureInPicture({ reason: "Foregrounded" });
  }

  // TikTok's own ▲ ▼ buttons; until TikTok has shown them, the next/previous item scrolled into
  // view (what the buttons do).
  #go(dir) {
    const doc = this.document;
    const button = doc.querySelector(`[data-e2e="feed-navigation-${dir}"]`);
    debug(`go ${dir}: button ${button ? (button.disabled ? "disabled" : "enabled") : "missing"}, hidden ${doc.hidden}`);
    if (button && !button.disabled) {
      button.click();
      return;
    }
    // The feed's items are one-column-item-0, -1…
    const item = this.#playingVideo()?.closest("[id^='one-column-item-']") ?? this.#pip?.closest("[id^='one-column-item-']");
    const n = Number(item?.id.split("-").pop()) + (dir === "next" ? 1 : -1);
    doc.getElementById(`one-column-item-${n}`)?.scrollIntoView({ block: "start" });
  }

  // TikTok plays each post in a <video> of its own (and reuses them): when TikTok's current video
  // starts while a PiP is open, the PiP window shows it instead of closing.
  #follow(video) {
    const pip = this.#pipWindow();
    debug(`play ${video.currentSrc.slice(-12)}: PiP ${pip ? `on ${pip.video.currentSrc.slice(-12)}, copying ${pip.video.isCloningElementVisually}` : "closed"}`);
    if (!pip || (pip.video === video && video.isCloningElementVisually)) return;
    // Not for videos TikTok plays elsewhere (hidden, LIVE previews, a profile's grid).
    if (video !== this.#playingVideo()) return;
    const { video: old, actor, playerVideo } = pip;
    if (old !== video) {
      // Firefox would close the PiP if the old video's source goes away.
      clearTimeout(actor.emptiedTimeout);
      actor.untrackOriginatingVideo(old);
      if (old.isCloningElementVisually) old.stopCloningElementVisually();
      actor.weakVideo = Cu.getWeakReference(video);
      this.#pipActors.set(video, actor);
      actor.trackOriginatingVideo(video);
    }
    this.#pip = video;
    video.cloneElementVisually(playerVideo);
    actor.stylePlayerVideo(video, playerVideo);
  }
}
