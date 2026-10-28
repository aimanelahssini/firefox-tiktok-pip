// Shared test setup: test clips, and a private copy of the system Firefox with TikTok PiP
// installed the way users get it (install.sh, my-gnome-setup's mozilla.cfg if present).
// Kept in ~/.cache/firefox-tiktok-pip-tests; the copy is a btrfs reflink, so it costs no space.
import {execFileSync} from 'node:child_process';
import {createReadStream, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..');
export const CACHE = join(homedir(), '.cache/firefox-tiktok-pip-tests');
export const COLORS = {red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0]};

export function clips() {
    const dir = join(CACHE, 'media');
    mkdirSync(dir, {recursive: true});
    for (const c of Object.keys(COLORS)) {
        const out = join(dir, `${c}.webm`);
        if (existsSync(out))
            continue;
        // Bounded: 30 s, small, and capped in memory.
        execFileSync('systemd-run', ['--user', '--quiet', '--wait', '--collect', '-p', 'MemoryMax=1G',
            'ffmpeg', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-t', '30', '-i', `color=c=${c}:s=270x480:r=15`,
            '-f', 'lavfi', '-t', '30', '-i', 'sine=frequency=440',
            '-c:v', 'libvpx-vp9', '-b:v', '50k', '-c:a', 'libopus', '-shortest', out]);
    }
    return dir;
}

export function firefox() {
    const sys = dirname(execFileSync('readlink', ['-f', '/usr/lib64/firefox/firefox']).toString().trim());
    const ff = join(CACHE, 'firefox');
    const ini = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (ini(join(ff, 'application.ini')) !== ini(join(sys, 'application.ini'))) {
        rmSync(ff, {recursive: true, force: true});
        execFileSync('cp', ['-a', '--reflink=auto', sys, ff]);
    }
    for (const f of ['mozilla.cfg', 'defaults/pref/autoconfig.js', 'autoconfig.d'])
        rmSync(join(ff, f), {recursive: true, force: true});
    const mgs = join(homedir(), 'Projects/my-gnome-setup/files/firefox-tabs');
    if (!process.env.OWN_LOADER && existsSync(join(mgs, 'mozilla.cfg'))) {
        copyFileSync(join(mgs, 'mozilla.cfg'), join(ff, 'mozilla.cfg'));
        copyFileSync(join(mgs, 'autoconfig.js'), join(ff, 'defaults/pref/autoconfig.js'));
    }
    execFileSync('bash', [join(REPO, 'install.sh')], {env: {...process.env, FIREFOX_DIR: ff}});
    return join(ff, 'firefox');
}

// Makes 127.0.0.1 count as TikTok; Firefox's own console goes to its stdout.
export const TEST_PREFS = {'tiktok-pip.matches': 'http://127.0.0.1/*', 'devtools.console.stdout.chrome': true};

// feed.html and the clips on 127.0.0.1 (or localhost, which isn't "TikTok").
export async function serveFeed() {
    const media = clips();
    const server = createServer((req, res) => {
        const name = req.url.split('?')[0].slice(1);
        const file = name === 'feed.html' ? join(HERE, name) : join(media, name);
        res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : 'video/webm');
        createReadStream(file).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
    }).listen(0, '127.0.0.1');
    await new Promise(r => server.on('listening', r));
    return {server, port: server.address().port};
}

export const PIPS = '[...Services.wm.getEnumerator("Toolkit:PictureInPicture")]';

// Open PiP windows, each counted once in window.__pipCloses when it closes.
export const pipsOf = ff => () => ff.chrome(`(() => {
    const ps = ${PIPS};
    for (const p of ps)
        if (!p.__watched) {
            p.__watched = true;
            p.addEventListener('unload', () => { window.__pipCloses = (window.__pipCloses ?? 0) + 1; });
        }
    return ps.map(p => ({id: p.docShell.outerWindowID, tiktok: p.document.documentElement.hasAttribute('tiktok'),
        focused: Services.focus.activeWindow === p, ready: p.document.readyState}));
})()`);
