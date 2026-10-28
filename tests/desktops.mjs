// The checks of desktops.sh, from outside the throwaway GNOME Shell it runs.
//   node desktops.mjs prepare             prints "<firefox> <profile> <port>" for the shell to start
//   node desktops.mjs run <port> <out>    drives the shell (through <out>/cmd) and Firefox
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {args, connect, profile, sleep, until} from './ff.mjs';
import {TEST_PREFS, firefox, pipsOf, serveFeed} from './setup.mjs';

const [mode, port, out] = process.argv.slice(2);
if (mode === 'prepare') {
    const p = 9600 + Math.floor(Math.random() * 400);
    console.log([firefox(), ...args(profile(TEST_PREFS), p)].join(' '));
    process.exit(0);
}

let n = 0;
// Runs a command in the shell and returns its answer.
async function shell(cmd) {
    const id = ++n;
    writeFileSync(`${out}/cmd`, `${id} ${cmd}`);
    const ack = `${out}/ack-${id}`;
    if (!await until(() => existsSync(ack), 10000))
        throw new Error(`the shell didn't answer "${cmd}"`);
    return readFileSync(ack, 'utf8');
}

const results = [];
const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

const {server, port: feedPort} = await serveFeed();
const ff = await connect(Number(port));
const pips = pipsOf(ff);
const playing = () => ff.eval('!feed.videos[feed.index].paused');
// Hiding a window reaches Firefox after GNOME's suspend delay (2-4 s).
const HIDE_MS = 8000;
try {
    await ff.go(`http://127.0.0.1:${feedPort}/feed.html`);
    check('feed plays', await until(playing, 10000));
    await sleep(1000);
    check('no PiP while you watch', (await pips()).length === 0);

    const withPipEverywhere = !!process.env.WITH_PIP_EVERYWHERE;
    // With PiP Everywhere, GNOME Shell tells Firefox at once; without it, Firefox hears 2-4 s late.
    const FAST_MS = 1500;
    const timed = async (cmd, want) => {
        await shell(cmd);
        const t0 = Date.now();
        const ok = await until(async () => (await pips()).length === want, HIDE_MS);
        return ok ? Date.now() - t0 : null;
    };

    let ms = await timed('desk 1', 1);
    check('another desktop: TikTok goes to PiP', ms !== null, `${ms} ms`);
    if (withPipEverywhere)
        check('…at once (PiP Everywhere tells Firefox)', ms !== null && ms < FAST_MS, `${ms} ms`);
    check('…still playing', await playing());
    await sleep(500);
    let info = JSON.parse(await shell('info'));
    if (withPipEverywhere)
        check('PiP Everywhere: on top, on every desktop, no zoom-in', info.length === 1 && info[0].sticky && info[0].above
            && info[0].animated !== true, JSON.stringify(info));

    // You put it somewhere: it comes back there next time (Firefox keeps the video's shape, so the
    // size is what it agreed to)
    let placed = null;
    if (withPipEverywhere)
        placed = (await shell('place 900 80 270 480')).split(' ').map(Number);
    ms = await timed('desk 0', 0);
    check('back on its desktop: PiP closes', ms !== null, `${ms} ms`);
    check('…still playing in the page', await playing());

    await sleep(1000);
    ms = await timed('minimize', 1);
    check('Firefox minimized: PiP', ms !== null, `${ms} ms`);
    if (withPipEverywhere) {
        check('…at once', ms !== null && ms < FAST_MS, `${ms} ms`);
        await sleep(500);
        info = JSON.parse(await shell('info'));
        const near = (a, b) => Math.abs(a - b) <= 2;
        check('PiP comes back where you put it, same size', info.length === 1 && info[0].x === 900 && info[0].y === 80
            && near(info[0].width, placed[2]) && near(info[0].height, placed[3]), JSON.stringify([placed, info]));
    }
    ms = await timed('unminimize', 0);
    check('Firefox back: PiP closes', ms !== null, `${ms} ms`);

    await sleep(1000);
    await shell('cover');
    check('covered by a window: PiP', await until(async () => (await pips()).length === 1, HIDE_MS));
    await shell('uncover');
    check('uncovered: PiP closes', await until(async () => (await pips()).length === 0, 3000));
} catch (e) {
    check('no errors', false, e.stack);
} finally {
    await ff.quit();
    server.close();
}
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
