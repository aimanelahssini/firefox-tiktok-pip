// TikTok picture-in-picture in a headless copy of the system Firefox, against a stand-in for
// TikTok's feed (feed.html) served on 127.0.0.1. Desktops and covering windows need a real
// compositor: see desktops.sh.
//   node tests/tiktok-pip.test.mjs
import {start, sleep, until} from './ff.mjs';
import {COLORS, PIPS, TEST_PREFS, firefox, pipsOf, serveFeed} from './setup.mjs';

const {server, port} = await serveFeed();
const FEED = `http://127.0.0.1:${port}/feed.html`;
// Same page on another host name: not "TikTok" for the add-on.
const OTHER = `http://localhost:${port}/feed.html`;

const results = [];
const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

const ff = await start({binary: firefox(), prefs: TEST_PREFS});
const pips = pipsOf(ff);
const closes = () => ff.chrome('window.__pipCloses ?? 0');
// The colour in the middle of the PiP window: which clip it shows.
const pipColor = () => ff.chrome(`(async () => {
    const p = ${PIPS}[0];
    if (!p) return null;
    const bmp = await p.document.getElementById('browser').browsingContext.currentWindowGlobal.drawSnapshot(null, 1, 'white');
    const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return [...g.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data].slice(0, 3);
})()`).then(rgb => rgb && Object.entries(COLORS).sort(([, a], [, b]) =>
    a.reduce((s, x, i) => s + (x - rgb[i]) ** 2, 0) - b.reduce((s, x, i) => s + (x - rgb[i]) ** 2, 0))[0][0]);
// Selects a tab the way a click on it does (BiDi's activate waits for window focus, which a
// PiP window takes part in).
const tabs = [];
const show = ctx => ff.chrome(`gBrowser.selectedTab = gBrowser.tabs[${tabs.indexOf(ctx)}]; 1`);
const key = (k, code) => ff.chrome(`(() => {
    const p = ${PIPS}[0];
    p.document.documentElement.dispatchEvent(new p.KeyboardEvent('keydown', {key: '${k}', keyCode: ${code}, bubbles: true, cancelable: true}));
    return true;
})()`);
const button = id => ff.chrome(`(() => {
    const b = ${PIPS}[0].document.getElementById('${id}');
    const shown = b.ownerDocument.defaultView.getComputedStyle(b).display !== 'none';
    b.click();
    return shown;
})()`);

try {
    const tiktok = ff.ctx;
    await ff.go(FEED);
    const feed = () => ff.eval(`({index: feed.index, playing: feed.videos.map(v => !v.paused),
        time: feed.videos[feed.index].currentTime, volume: feed.videos[feed.index].volume, log: feed.log.join(', ')})`, tiktok);
    check('feed plays', await until(async () => (await feed()).playing[0]));
    const other = await ff.newTab('about:blank');
    const third = await ff.newTab('about:blank');
    tabs.push(tiktok, other, third);

    // Leaving the tab
    await show(other);
    let p = await until(async () => (await pips()).find(x => x.ready === 'complete'));
    check('another tab: TikTok goes to PiP', !!p);
    const pipId = p?.id;
    let f = await feed();
    check('TikTok keeps playing (its pause on a hidden tab is held back)', f.playing[0] && !f.log.includes('visibility hidden'), f.log);
    check('the PiP doesn\'t take focus', !p?.focused);
    check('▲ ▼ shown on a TikTok PiP', await until(async () => (await pips())[0]?.tiktok, 3000));
    check('PiP shows the playing video', await until(async () => (await pipColor()) === 'red', 3000));

    // Moving around other tabs
    await show(third);
    await sleep(800);
    await show(other);
    await sleep(800);
    let now = await pips();
    check('tab to tab: the same PiP stays, never closed', now.length === 1 && now[0].id === pipId && await closes() === 0,
        JSON.stringify(now));

    // Switching TikToks from the PiP
    const before = (await feed()).volume;
    await key('ArrowDown', 40);
    f = await until(async () => { const x = await feed(); return x.index === 1 && x.playing[1] && x; });
    check('↓ in the PiP: next TikTok', !!f, JSON.stringify(await feed()));
    check('↓: the PiP follows to it (same window)', await until(async () => (await pipColor()) === 'green', 3000)
        && (await pips())[0]?.id === pipId && await closes() === 0);
    await key('ArrowUp', 38);
    check('↑ in the PiP: previous TikTok, PiP follows',
        await until(async () => (await feed()).index === 0 && (await pipColor()) === 'red'));
    check('↑/↓ don\'t change the volume', (await feed()).volume === before);
    check('▼ button shown and goes to the next TikTok', await button('tiktok-next')
        && await until(async () => (await feed()).index === 1 && (await pipColor()) === 'green'));
    check('▲ button goes back', await button('tiktok-prev') && await until(async () => (await feed()).index === 0));
    check('TikTok got real clicks/keys (no untrusted ones)', !(await feed()).log.includes('untrusted'));
    const t0 = (await feed()).time;
    await key('ArrowRight', 39);
    check('→ still seeks', await until(async () => (await feed()).time >= t0 + 4, 2000));
    check('still the same PiP window', (await pips())[0]?.id === pipId && await closes() === 0);

    // Coming back
    const index = (await feed()).index;
    await show(tiktok);
    check('back on TikTok: PiP closes', await until(async () => (await pips()).length === 0));
    f = await feed();
    const t1 = f.time;
    await sleep(1000);
    f = await feed();
    check('the video goes on in the page', f.index === index && f.playing[index] && f.time > t1, JSON.stringify(f));

    // Paused: nothing pops up
    await ff.eval('feed.videos[feed.index].pause()', tiktok);
    await show(other);
    await sleep(1500);
    check('paused video: no PiP', (await pips()).length === 0, JSON.stringify([await pips(), await feed()]));
    await show(tiktok);
    await ff.eval('feed.videos[feed.index].play()', tiktok);
    await sleep(500);

    // Closed by hand while away
    await show(other);
    check('PiP again on leaving', await until(async () => (await pips()).length === 1));
    await sleep(500);
    await ff.chrome(`${PIPS}[0].document.getElementById('close').click(); 1`);
    await until(async () => (await pips()).length === 0);
    await show(third);
    await sleep(1500);
    check('✕ while away: stays closed', (await pips()).length === 0);
    await show(tiktok);
    await sleep(800);
    check('…and nothing on coming back', (await pips()).length === 0);
    await ff.eval('feed.videos[feed.index].play()', tiktok);
    await sleep(500);

    // Opened by hand while watching: stays until you've left and come back
    const toggle = () => ff.chrome(`gBrowser.selectedBrowser.browsingContext.currentWindowGlobal
        .getActor('PictureInPictureLauncher').sendAsyncMessage('PictureInPicture:KeyToggle'); 1`);
    await toggle();
    check('PiP by hand while on TikTok', await until(async () => (await pips()).length === 1));
    await sleep(1500);
    check('…stays while you watch', (await pips()).length === 1);
    await show(other);
    await sleep(800);
    check('…stays when you leave', (await pips()).length === 1);
    await show(tiktok);
    check('…closes when you come back', await until(async () => (await pips()).length === 0));

    // Scrolling the page while a PiP is open: the PiP follows
    await toggle();
    await until(async () => (await pips()).length === 1);
    await sleep(500);
    // TikTok moving on by itself (its own scroll or autoscroll)
    await ff.eval('go(feed.index + 1)', tiktok);
    check('scrolling the page: PiP follows to the next video', await until(async () => (await pipColor()) === 'green'));
    await ff.chrome(`${PIPS}[0].document.getElementById('close').click(); 1`);
    await until(async () => (await pips()).length === 0);
    await ff.eval('feed.videos[feed.index].play()', tiktok);

    // Minimized
    await ff.chrome('window.minimize(); 1');
    const minimized = await until(async () => (await pips()).length === 1, 3000);
    const state = await ff.chrome('window.windowState');
    if (state === 2) {
        check('Firefox minimized: TikTok goes to PiP', minimized);
        await ff.chrome('window.restore(); 1');
        check('restored: PiP closes', await until(async () => (await pips()).length === 0));
    } else {
        console.log('SKIP minimize (headless Firefox doesn\'t minimize; see desktops.sh)');
        await ff.chrome('window.restore(); 1');
    }

    // Not TikTok: a plain PiP, no buttons
    await ff.eval('feed.videos[feed.index].pause()', tiktok);
    await show(other);
    ff.ctx = other;
    await ff.go(OTHER).catch(() => {});
    await until(() => ff.eval('feed.videos[0].readyState > 2 && !feed.videos[0].paused'), 10000);
    await toggle();
    const plain = (await until(async () => (await pips()).find(x => x.ready === 'complete'), 8000));
    await sleep(800);
    if (!plain)
        console.log('other site:', JSON.stringify(await ff.eval('({paused: feed.videos[0].paused, ready: feed.videos[0].readyState, href: location.href})')));
    const shown = await ff.chrome(`(() => { const b = ${PIPS}[0].document.getElementById('tiktok-next'); return b.ownerDocument.defaultView.getComputedStyle(b).display !== 'none'; })()`);
    check('other sites: no ▲ ▼', plain && !plain.tiktok && !shown, JSON.stringify([plain, shown]));
} catch (e) {
    check('no errors', false, e.stack);
} finally {
    await ff.quit();
    server.close();
}
const failed = results.filter(r => !r).length;
// Our own errors, from Firefox's console
const errors = ff.stderr().split('\n').filter(l => /tiktok-pip|autoconfig/i.test(l));
if (errors.length)
    console.log(errors.slice(0, 20).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
