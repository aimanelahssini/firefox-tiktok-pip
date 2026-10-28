// Minimal WebDriver BiDi driver for a throwaway headless Firefox (no extra packages needed),
// adapted from gnome-veil's tests. chrome() runs code in Firefox's own windows.
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Polls fn until it returns something truthy (or the time runs out; then the last value).
export async function until(fn, ms = 5000) {
    let v;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150))
        if ((v = await fn()))
            return v;
    return v;
}

// A throwaway profile with test prefs; returns its folder.
export function profile(prefs = {}) {
    const dir = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'ffprof-'));
    const allPrefs = {
        'browser.shell.checkDefaultBrowser': false,
        'datareporting.policy.dataSubmissionEnabled': false,
        'browser.aboutwelcome.enabled': false,
        'browser.startup.homepage_override.mstone': 'ignore',
        'browser.tabs.warnOnClose': false,
        // Headless still plays sound: keep test videos off the speakers
        'media.volume_scale': '0.0',
        'media.autoplay.default': 0,
        ...prefs,
    };
    writeFileSync(join(dir, 'user.js'),
        Object.entries(allPrefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
    return dir;
}

// Firefox's command line for a profile and a WebDriver BiDi port.
export const args = (dir, port) => ['--no-remote', '--profile', dir, `--remote-debugging-port=${port}`,
    '-remote-allow-system-access'];

export async function start({binary = 'firefox', port = 9600 + Math.floor(Math.random() * 400), headless = true, prefs = {}, env = {}} = {}) {
    const a = args(profile(prefs), port);
    if (headless)
        a.unshift('--headless');
    const proc = spawn(binary, a, {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdout.on('data', d => { stderr += d; });
    return connect(port, proc, () => stderr);
}

// Talks to a Firefox already listening on port (started by start() or someone else).
export async function connect(port, proc = null, stderr = () => '') {
    let ws;
    for (let i = 0; i < 60 && !ws; i++) {
        await sleep(500);
        try {
            ws = await new Promise((res, rej) => {
                const s = new WebSocket(`ws://127.0.0.1:${port}/session`);
                s.onopen = () => res(s);
                s.onerror = e => rej(e);
            });
        } catch {}
    }
    if (!ws)
        throw new Error('firefox did not start: ' + stderr());
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const {res, rej} = pending.get(m.id);
            pending.delete(m.id);
            if (m.type === 'error')
                rej(new Error(`${m.error}: ${m.message}`));
            else
                res(m.result);
        }
    };
    const cmd = (method, params = {}) => new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, {res, rej});
        ws.send(JSON.stringify({id: i, method, params}));
        setTimeout(() => pending.delete(i) && rej(new Error(`${method} timed out: ${JSON.stringify(params).slice(0, 200)}`)), 15000);
    });
    await cmd('session.new', {capabilities: {}});
    const evaluate = async (context, expr) => {
        const r = await cmd('script.evaluate', {expression: expr, target: {context}, awaitPromise: true, resultOwnership: 'none'});
        if (r.type === 'exception')
            throw new Error(r.exceptionDetails.text);
        return deser(r.result);
    };
    const ff = {
        proc, cmd, stderr,
        ctx: (await cmd('browsingContext.getTree', {})).contexts[0].context,
        // Starts loading url and waits for the page's own scripts (a fresh profile's first
        // navigation sometimes never reports back).
        async go(url, context = this.ctx) {
            await cmd('browsingContext.navigate', {context, url, wait: 'none'});
            const ready = await until(() => evaluate(context,
                `location.href === ${JSON.stringify(url)} && document.readyState !== 'loading'`).catch(() => false), 15000);
            if (!ready)
                throw new Error(`${url} didn't load`);
        },
        async newTab(url) {
            const c = (await cmd('browsingContext.create', {type: 'tab', background: true})).context;
            if (url)
                await this.go(url, c);
            return c;
        },
        // Brings a tab to the front (Firefox's TabSelect, like a click on the tab).
        show: context => cmd('browsingContext.activate', {context}),
        eval(expr, context = this.ctx) {
            return evaluate(context, expr);
        },
        // Code in the first browser window (browser.xhtml): gBrowser, Services, ChromeUtils...
        async chrome(expr) {
            const ctx = (await cmd('browsingContext.getTree', {'moz:scope': 'chrome'})).contexts
                .find(c => c.url === 'chrome://browser/content/browser.xhtml').context;
            return evaluate(ctx, expr);
        },
        async quit() {
            try { await cmd('browser.close', {}); } catch {}
            if (!proc)
                return;
            const exited = new Promise(r => proc.exitCode !== null ? r() : proc.once('exit', r));
            if (!await Promise.race([exited.then(() => true), sleep(5000)]))
                proc.kill('SIGKILL');
        },
    };
    return ff;
}

function deser(v) {
    if (!v)
        return v;
    switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'number': case 'boolean': return v.value;
    case 'array': return v.value.map(deser);
    case 'object': return Object.fromEntries(v.value.map(([k, x]) => [typeof k === 'string' ? k : deser(k), deser(x)]));
    default: return v.value ?? v.type;
    }
}
