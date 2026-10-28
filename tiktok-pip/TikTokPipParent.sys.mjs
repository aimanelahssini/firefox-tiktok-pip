// The parent side of the TikTokPip actor: main.sys.mjs sends the page its messages through it.
export class TikTokPipParent extends JSWindowActorParent {
  receiveMessage(message) {
    // The page went to PiP after its tab was put to sleep: wake it (as Firefox's own "PiP when
    // switching tabs" does), so TikTok can scroll and play the next video behind the PiP.
    // Firefox puts it back to sleep when the PiP closes.
    if (message.name === "TikTokPip:Opened") {
      const browser = this.browsingContext.top.embedderElement;
      if (browser) browser.docShellIsActive = true;
    }
  }
}
