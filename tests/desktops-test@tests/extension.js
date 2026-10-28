// Test driver for desktops.sh, inside a throwaway GNOME Shell: starts Firefox, then runs the
// commands desktops.mjs writes to $TT_OUT/cmd ("<id> <command>"), answering in $TT_OUT/ack-<id>.
//   desk N    switch to desktop N
//   cover     a maximized window on top of Firefox; uncover closes it
//   minimize  minimizes Firefox; unminimize brings it back
//   place X Y W H   moves/resizes the PiP window, as if dragged there (PiP Everywhere remembers it)
//   info      the PiP windows: on all desktops? on top? animated when they appeared? where?
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('TT_OUT');
const write = (name, text) => GLib.file_set_contents(`${OUT}/${name}`, text);
const read = name => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${OUT}/${name}`)[1]);
    } catch {
        return '';
    }
};
const windows = () => global.get_window_actors().map(a => a.meta_window);
const isPip = w => /^picture-in-picture$/i.test(w.get_title() ?? '');
const firefox = () => windows().find(w => /firefox/i.test(w.get_wm_class() ?? '') && !isPip(w));

export default class DesktopsTest extends Extension {
    enable() {
        write('shell.pid', String(new Gio.Credentials().get_unix_pid()));
        this._done = new Set();
        this._animated = {};
        // Is the window still animating 60 ms after it appeared? (GNOME's zoom-in starts small
        // and see-through, and takes longer than that.)
        global.window_manager.connect('map', (wm, actor) => {
            // Every window: a PiP's title can arrive after it appears.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                const w = actor.meta_window;
                if (w)
                    this._animated[w.get_id()] = actor.opacity < 255 || actor.scale_x < 1;
                return GLib.SOURCE_REMOVE;
            });
        });
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            Main.overview.hide();
            GLib.spawn_command_line_async(GLib.getenv('TT_FIREFOX'));
            return GLib.SOURCE_REMOVE;
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => this._poll());
    }

    _poll() {
        const [id, cmd, ...args] = read('cmd').trim().split(' ');
        if (id && !this._done.has(id)) {
            this._done.add(id);
            Promise.resolve().then(() => this._run(cmd, ...args))
                .then(answer => write(`ack-${id}`, answer ?? 'ok'), e => write(`ack-${id}`, `error ${e}`));
        }
        return GLib.SOURCE_CONTINUE;
    }

    _run(cmd, ...args) {
        const arg = args[0];
        const time = global.get_current_time();
        switch (cmd) {
        case 'desk':
            global.workspace_manager.get_workspace_by_index(Number(arg)).activate(time);
            return;
        case 'cover':
            GLib.spawn_command_line_async(`gjs -m ${GLib.getenv('TT_COVER')}`);
            return;
        case 'uncover':
            windows().find(w => w.get_title() === 'cover')?.delete(time);
            return;
        case 'minimize':
            firefox().minimize();
            return;
        case 'unminimize':
            firefox().unminimize();
            firefox().activate(time);
            return;
        case 'place': {
            const [x, y, width, height] = args.map(Number);
            const w = windows().find(isPip);
            w.move_resize_frame(true, x, y, width, height);
            // Firefox takes a moment to agree on the size. Then, what a drag ends with:
            return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                Main.extensionManager.lookup('pip-everywhere@aimanelahssini').stateObj._remember(w);
                const r = w.get_frame_rect();
                resolve(`${r.x} ${r.y} ${r.width} ${r.height}`);
                return GLib.SOURCE_REMOVE;
            }));
        }
        case 'info':
            return JSON.stringify(windows().filter(isPip).map(w => {
                const {x, y, width, height} = w.get_frame_rect();
                return {sticky: w.is_on_all_workspaces(), above: w.is_above(), animated: this._animated[w.get_id()] ?? null,
                    x, y, width, height};
            }));
        }
        throw new Error(`unknown command ${cmd}`);
    }

    disable() {}
}
