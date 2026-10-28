// Test driver for desktops.sh, inside a throwaway GNOME Shell: starts Firefox, then runs the
// commands desktops.mjs writes to $TT_OUT/cmd ("<id> <command>"), answering in $TT_OUT/ack-<id>.
//   desk N    switch to desktop N
//   cover     a maximized window on top of Firefox; uncover closes it
//   info      the PiP windows: on all desktops? on top? animated when they appeared?
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

export default class DesktopsTest extends Extension {
    enable() {
        write('shell.pid', String(new Gio.Credentials().get_unix_pid()));
        this._done = new Set();
        this._animated = {};
        // Is the window still animating 60 ms after it appeared? (GNOME's zoom-in starts small
        // and see-through, and takes longer than that.)
        global.window_manager.connect('map', (wm, actor) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                const w = actor.meta_window;
                if (w && isPip(w))
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
        const [id, cmd, arg] = read('cmd').trim().split(' ');
        if (id && !this._done.has(id)) {
            this._done.add(id);
            let answer = 'ok';
            try {
                answer = this._run(cmd, arg) ?? 'ok';
            } catch (e) {
                answer = `error ${e}`;
            }
            write(`ack-${id}`, answer);
        }
        return GLib.SOURCE_CONTINUE;
    }

    _run(cmd, arg) {
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
        case 'info':
            return JSON.stringify(windows().filter(isPip).map(w => ({
                sticky: w.is_on_all_workspaces(), above: w.is_above(), animated: this._animated[w.get_id()] ?? null,
            })));
        }
        throw new Error(`unknown command ${cmd}`);
    }

    disable() {}
}
