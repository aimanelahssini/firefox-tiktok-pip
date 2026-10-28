// The TikTok page's side of main.sys.mjs: opens and closes the picture-in-picture, moves to the
// previous/next TikTok, and keeps the open PiP window on whichever video plays.

import { getActorFor } from "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// TikTok pauses its video when the tab goes hidden: a pause this soon after is TikTok's, and the
// video still counts as playing for JUST_PAUSED_MS.
const HIDDEN_PAUSE_MS = 500;
const JUST_PAUSED_MS = 2000;
// How long TikTok gets to react to a key before we scroll ourselves.
const KEY_WAIT_MS = 500;

export class TikTokPipChild extends JSWindowActorChild {
  // PiP opened or kept while TikTok wasn't showing; closed again when it is.
  #away = false;
  #hiddenAt = 0;
  #pausedVideo = null;
  #pausedAt = 0;
  // Videos we moved an open PiP to; Firefox only knows the first one.
  #pipActors = new WeakMap();

  handleEvent(event) {
    if (event.type !== "DOMWindowCreated") return;
    const win = this.contentWindow;
    // TikTok pauses when its tab is hidden. While a video plays it's about to go to PiP, so
    // TikTok doesn't hear about it (window capture runs before the page's listeners).
    win.addEventListener("visibilitychange", e => {
      if (!this.document.hidden) return;
      this.#hiddenAt = Date.now();
      if (this.#playingVideo()) e.stopImmediatePropagation();
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

  #playingVideo() {
    return this.#videos().find(v => !v.paused && !v.ended);
  }

  #pipVideo() {
    return this.#videos().find(v => v.isCloningElementVisually);
  }

  #pipActor(video) {
    return getActorFor(video) ?? this.#pipActors.get(video);
  }

  #leave() {
    if (this.#pipVideo()) {
      // Already in PiP (opened by hand): it stays, and now closes when you're back.
      this.#away = true;
      return;
    }
    let video = this.#playingVideo();
    if (!video && this.#pausedVideo?.isConnected && Date.now() - this.#pausedAt < JUST_PAUSED_MS) {
      video = this.#pausedVideo;
      video.play();
    }
    if (!video) return;
    this.#away = true;
    // Same as Firefox's own "PiP when switching tabs", which doesn't take focus.
    this.contentWindow.windowGlobalChild.getActor("PictureInPictureLauncher")
      .togglePictureInPicture({ video, reason: "AutoPip" }, false);
  }

  #back() {
    if (!this.#away) return;
    this.#away = false;
    const video = this.#pipVideo();
    if (video) this.#pipActor(video)?.closePictureInPicture({ reason: "Foregrounded" });
  }

  // TikTok's own ▲ ▼ buttons; its ↑/↓ keys, then scrolling, if they're gone.
  #go(dir) {
    const doc = this.document;
    const button = doc.querySelector(`[data-e2e="feed-navigation-${dir}"]`);
    if (button && !button.disabled) {
      button.click();
      return;
    }
    const before = this.#pipVideo() ?? this.#playingVideo();
    const key = dir === "next" ? "ArrowDown" : "ArrowUp";
    const target = doc.activeElement ?? doc.body;
    target.dispatchEvent(new this.contentWindow.KeyboardEvent("keydown",
      { key, code: key, keyCode: dir === "next" ? 40 : 38, bubbles: true, cancelable: true }));
    setTimeout(() => {
      if ((this.#pipVideo() ?? this.#playingVideo()) !== before) return;
      const item = before?.closest("article");
      const other = dir === "next" ? item?.nextElementSibling : item?.previousElementSibling;
      other?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, KEY_WAIT_MS);
  }

  // TikTok has a <video> per item: when another one starts while a PiP is open, the PiP window
  // switches to it instead of closing.
  #follow(video) {
    const old = this.#pipVideo();
    if (!old || old === video) return;
    // Not for small previews (a profile's grid) while the feed's video is in PiP.
    const area = v => v.clientWidth * v.clientHeight;
    if (area(video) < area(old) / 2) return;
    const actor = this.#pipActor(old);
    const playerVideo = actor?.document?.getElementById("playervideo");
    if (!playerVideo) return;
    // Firefox would close the PiP if the old video's source goes away.
    clearTimeout(actor.emptiedTimeout);
    actor.untrackOriginatingVideo(old);
    old.stopCloningElementVisually();
    actor.weakVideo = Cu.getWeakReference(video);
    this.#pipActors.set(video, actor);
    video.cloneElementVisually(playerVideo);
    actor.stylePlayerVideo(video, playerVideo);
    actor.trackOriginatingVideo(video);
  }
}
