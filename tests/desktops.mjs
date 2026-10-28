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

    await shell('desk 1');
    check('another desktop: TikTok goes to PiP', await until(async () => (await pips()).length === 1, HIDE_MS));
    check('…still playing', await playing());
    await sleep(500);
    const info = JSON.parse(await shell('info'));
    if (process.env.WITH_PIP_EVERYWHERE)
        check('PiP Everywhere: on top, on every desktop, no zoom-in', info.length === 1 && info[0].sticky && info[0].above
            && info[0].animated === false, JSON.stringify(info));

    await shell('desk 0');
    check('back on its desktop: PiP closes', await until(async () => (await pips()).length === 0, 3000));
    check('…still playing in the page', await playing());

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
