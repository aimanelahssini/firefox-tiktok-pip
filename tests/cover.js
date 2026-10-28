// A maximized window titled "cover", to hide Firefox behind (desktops.sh).
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({application_id: 'test.tiktokpip.cover'});
app.connect('activate', () => {
    const w = new Gtk.ApplicationWindow({application: app, title: 'cover'});
    w.maximize();
    w.present();
});
app.run([]);
