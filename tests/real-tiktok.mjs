// Checks against the real, logged-in TikTok (not part of the regular tests): opens the feed,
// leaves the tab, presses ↓/↑ in the PiP and prints what happened, with the add-on's debug log.
//   COOKIES=/path/to/cookies.sqlite node tests/real-tiktok.mjs
// COOKIES: a copy of a Firefox cookies.sqlite with only tiktok.com cookies in it.
import {copyFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {profile, start, sleep, until} from './ff.mjs';
import {PIPS, firefox, pipsOf} from './setup.mjs';

const dir = profile({'tiktok-pip.debug': true, 'browser.dom.window.dump.enabled': true,
    'devtools.console.stdout.chrome': true});
copyFileSync(process.env.COOKIES, join(dir, 'cookies.sqlite'));
const ff = await start({binary: firefox(), dir});
const pips = pipsOf(ff);
const state = () => ff.eval(`JSON.stringify({
    loggedIn: !document.querySelector('[data-e2e="top-login-button"], #header-login-button'),
    playing: [...document.querySelectorAll('video')].filter(v => !v.paused).map(v => (v.closest('article')?.id.split('-').pop() ?? '?') + ':' + v.currentSrc.slice(-12)),
    videos: document.querySelectorAll('video').length,
    nav: [...document.querySelectorAll('[data-e2e^="feed-navigation"]')].map(b => b.dataset.e2e.slice(16) + (b.disabled ? ':disabled' : ':enabled')),
    dialog: document.querySelector('[role=dialog]')?.innerText.slice(0, 40) ?? null,
})`, tiktok);
const key = (k, code) => ff.chrome(`(() => {
    const p = ${PIPS}[0];
    p.document.documentElement.dispatchEvent(new p.KeyboardEvent('keydown', {key: '${k}', keyCode: ${code}, bubbles: true, cancelable: true}));
    return true;
})()`);
const tiktok = ff.ctx;
try {
    await ff.go('https://www.tiktok.com/foryou');
    await until(async () => JSON.parse(await state()).playing.length, 15000);
    console.log('feed     ', await state());
    const other = await ff.newTab('about:blank');
    const t0 = Date.now();
    await ff.chrome('gBrowser.selectedTab = gBrowser.tabs[1]; 1');
    const p = await until(async () => (await pips()).find(x => x.ready === 'complete'), 8000);
    console.log(`leave     PiP ${p ? `after ${Date.now() - t0} ms` : 'did NOT open'}`, await state());
    // Like someone who watches a bit in the PiP first (TikTok ignores clicks right after loading).
    await sleep(Number(process.env.WAIT ?? 3000));
    for (const [k, code] of [['ArrowDown', 40], ['ArrowDown', 40], ['ArrowDown', 40], ['ArrowUp', 38], ['ArrowUp', 38]]) {
        if (!(await pips()).length)
            break;
        await key(k, code);
        await sleep(3500);
        const bar = await ff.chrome(`parseFloat(${PIPS}[0]?.document.querySelector('#tiktok-progress > div')?.style.width) || 0`);
        console.log(`${k.padEnd(10)}`, await state(), `pips ${(await pips()).length}, progress ${bar.toFixed(0)}%`);
    }
} catch (e) {
    console.log('ERROR', e.message);
} finally {
    await ff.quit();
    // It holds the cookies.
    rmSync(dir, {recursive: true, force: true});
    console.log(ff.stderr().split('\n').filter(l => /tiktok-pip|JavaScript error.*(tiktok|autoconfig)/i.test(l)).join('\n'));
}
