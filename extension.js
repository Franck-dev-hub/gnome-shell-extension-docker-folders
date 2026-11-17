// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const WORKDIR_LABEL = 'com.docker.compose.project.working_dir';
const SERVICE_LABEL = 'com.docker.compose.service';
const PS_FORMAT = `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${WORKDIR_LABEL}"}}\t{{.Label "${SERVICE_LABEL}"}}`;
// Compose files often sit in a docker/ subfolder: name the folder after the project root.
const COMPOSE_SUBDIRS = new Set(['docker', '.docker', 'compose']);
const TABS = [['running', 'Running'], ['stopped', 'Stopped']];
const EVENT_ARGS = [
    'events', '--format', '{{.Action}}', '--filter', 'type=container',
    '--filter', 'event=start', '--filter', 'event=die', '--filter', 'event=destroy',
    '--filter', 'event=pause', '--filter', 'event=unpause',
];
const REFRESH_DELAY_MS = 300;
const EVENTS_RETRY_S = 10;
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ghostty', '-e'],
    ['ptyxis', '--new-window', '--'],
    ['gnome-terminal', '--'],
    ['kgx', '--'],
];
const EXEC_SHELL = 'command -v bash >/dev/null && exec bash || exec sh';
// A stopped container's logs end at once: wait for a key so the window stays open.
const LOGS_SCRIPT = 'docker logs --tail 200 $2 "$1"; printf "\\n[Entrée pour fermer]"; read -r _';

const ACTIONS = {
    start: {icon: 'media-playback-start-symbolic', style: 'play', label: 'Lancer'},
    pause: {icon: 'media-playback-pause-symbolic', style: 'pause', label: 'Mettre en pause'},
    stop: {icon: 'media-playback-stop-symbolic', style: 'stop', label: 'Arrêter'},
    restart: {file: 'restart', style: 'restart', label: 'Redémarrer'},
    exec: {file: 'terminal', style: 'exec', label: 'Ouvrir un terminal'},
    logs: {file: 'logs', style: 'logs', label: 'Logs'},
};
const ICON_FILES = ['docker', 'compose', 'restart', 'terminal', 'logs'];

function runDocker(args, cancellable) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['docker', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (p.get_successful())
                    resolve(stdout);
                else
                    reject(new Error(stderr.trim() || `docker ${args[0]} a échoué`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function toState(dockerState) {
    if (dockerState === 'running' || dockerState === 'restarting')
        return 'running';
    return dockerState === 'paused' ? 'paused' : 'stopped';
}

function parseContainers(output) {
    return output.split('\n').filter(Boolean).map(line => {
        const [id, name, state, dir, service] = line.split('\t');
        return {id, name, state: toState(state), dir: dir ?? '', label: service || name};
    });
}

function folderName(dir) {
    if (!dir)
        return 'Autres';
    const parts = dir.split('/').filter(Boolean);
    const last = parts.at(-1);
    return COMPOSE_SUBDIRS.has(last) && parts.length > 1 ? parts.at(-2) : last;
}

function folderStatus(containers) {
    const running = containers.filter(c => c.state === 'running').length;
    if (running === containers.length)
        return 'green';
    return containers.every(c => c.state === 'stopped') ? 'red' : 'yellow';
}

function idsIn(containers, ...states) {
    return containers.filter(c => states.includes(c.state)).map(c => c.id);
}

function openInTerminal(args) {
    for (const [bin, ...flags] of TERMINALS) {
        const path = GLib.find_program_in_path(bin);
        if (path) {
            Util.spawn([path, ...flags, ...args]);
            return;
        }
    }
    Main.notifyError('Docker Folders', 'Aucun terminal trouvé');
}

function infoItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
    item.label.clutter_text.line_wrap = true;
    return item;
}

const DockerFoldersIndicator = GObject.registerClass(
class DockerFoldersIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, extension.metadata.name);

        this._icons = Object.fromEntries(ICON_FILES.map(name =>
            [name, Gio.icon_new_for_string(`${extension.path}/icons/${name}-symbolic.svg`)]));
        this._cancellable = new Gio.Cancellable();
        this._tab = 'running';
        this._containers = [];
        this._error = null;
        this._expanded = new Set();
        this._busy = new Set();
        this._refreshId = 0;
        this._rebuilding = false;
        this._refreshTimeoutId = 0;
        this._retryTimeoutId = 0;
        this._eventsProc = null;

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        box.add_child(new St.Icon({gicon: this._icons.docker, style_class: 'system-status-icon'}));
        this._countLabel = new St.Label({
            style_class: 'docker-folders-count',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._countLabel);
        this.add_child(box);
        this.menu.actor.add_style_class_name('docker-folders-menu');

        this._addTabs();
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        }, this);

        this._refresh();
        this._watchEvents();
    }

    _watchEvents() {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['docker', ...EVENT_ARGS],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            this._retryWatch();
            return;
        }
        this._eventsProc = proc;
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const readLine = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
            if (line === null) {
                // Docker stopped or restarted: the stream ended, so reconnect later.
                this._eventsProc = null;
                this._queueRefresh();
                this._retryWatch();
                return;
            }
            this._queueRefresh();
            readLine();
        });
        readLine();
    }

    _retryWatch() {
        this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EVENTS_RETRY_S, () => {
            this._retryTimeoutId = 0;
            this._watchEvents();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A compose up fires one event per container: refresh once for the whole burst.
    _queueRefresh() {
        if (this._refreshTimeoutId)
            return;
        this._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshTimeoutId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _addTabs() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'docker-folders-tabs', x_expand: true});
        this._tabButtons = new Map();
        for (const [key, label] of TABS) {
            const button = new St.Button({label, style_class: 'docker-folders-tab', can_focus: true, x_expand: true});
            button.connect('clicked', () => this._selectTab(key));
            box.add_child(button);
            this._tabButtons.set(key, button);
        }
        header.add_child(box);
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._syncTabs();
    }

    _syncTabs() {
        for (const [key, button] of this._tabButtons)
            button.checked = key === this._tab;
    }

    _selectTab(key) {
        this._tab = key;
        this._syncTabs();
        this._rebuild();
    }

    async _refresh() {
        const refreshId = ++this._refreshId;
        try {
            this._containers = parseContainers(
                await runDocker(['ps', '-a', '--format', PS_FORMAT], this._cancellable)
            );
            this._error = null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._error = e.message;
        }
        if (refreshId !== this._refreshId)
            return;
        this._syncCount();
        this._rebuild();
    }

    _syncCount() {
        this._countLabel.text = String(this._containers.filter(c => c.state === 'running').length);
        this._countLabel.visible = !this._error;
    }

    _rebuild() {
        this._rebuilding = true;
        this._section.removeAll();
        this._rebuilding = false;

        if (this._error) {
            this._section.addMenuItem(infoItem(`Docker indisponible : ${this._error}`));
            return;
        }

        const byDir = new Map();
        for (const container of this._containers) {
            if (!byDir.has(container.dir))
                byDir.set(container.dir, []);
            byDir.get(container.dir).push(container);
        }

        // A stack with one service up is still running: it stays whole in the Running tab.
        const wantRunning = this._tab === 'running';
        const folders = [...byDir]
            .filter(([, containers]) => containers.some(c => c.state !== 'stopped') === wantRunning)
            .map(([dir, containers]) => ({
                dir,
                name: folderName(dir),
                containers: containers.sort((a, b) => a.label.localeCompare(b.label)),
            }))
            .sort((a, b) => (a.dir === '') - (b.dir === '') || a.name.localeCompare(b.name));

        if (folders.length === 0) {
            this._section.addMenuItem(infoItem(wantRunning ? 'Aucun dossier lancé' : 'Aucun dossier arrêté'));
            return;
        }

        for (const folder of folders)
            this._addFolder(folder);
    }

    _addFolder(folder) {
        const {dir, containers} = folder;
        const running = containers.filter(c => c.state === 'running').length;
        const item = new PopupMenu.PopupSubMenuMenuItem(`${folder.name} (${running}/${containers.length})`, true);
        item.icon.gicon = dir ? this._icons.compose : this._icons.docker;
        item.icon.add_style_class_name(`docker-folders-${folderStatus(containers)}`);

        const toStart = idsIn(containers, 'stopped');
        const toUnpause = idsIn(containers, 'paused');
        const up = idsIn(containers, 'running', 'paused');
        item.insert_child_at_index(this._actionsBox(`folder:${dir}`, [
            ['start', [['start', ...toStart], ['unpause', ...toUnpause]], toStart.length + toUnpause.length > 0],
            ['stop', [['stop', ...up]], up.length > 0],
            ['restart', [['restart', ...up]], up.length > 0],
        ]), item.get_n_children() - 1);

        for (const container of containers)
            item.menu.addMenuItem(this._containerItem(container));

        item.menu.connectObject('open-state-changed', (_menu, open) => {
            // Closing the panel menu also closes submenus: keep what the user expanded.
            if (this._rebuilding || !this.menu.isOpen)
                return;
            if (open)
                this._expanded.add(dir);
            else
                this._expanded.delete(dir);
        }, this);

        this._section.addMenuItem(item);
        if (this._expanded.has(dir))
            item.menu.open(false);
    }

    _containerItem(container) {
        const {id, state} = container;
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        const color = {running: 'green', paused: 'yellow', stopped: 'red'}[state];
        item.add_child(new St.Icon({
            gicon: this._icons.docker,
            style_class: `popup-menu-icon docker-folders-${color}`,
        }));
        item.add_child(new St.Label({text: container.label, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));

        const logs = ['logs', () => openInTerminal(
            ['sh', '-c', LOGS_SCRIPT, 'sh', id, state === 'stopped' ? '' : '--follow']
        ), true];
        const actions = {
            running: [
                ['pause', [['pause', id]], true],
                ['stop', [['stop', id]], true],
                ['restart', [['restart', id]], true],
                ['exec', () => openInTerminal(['docker', 'exec', '-it', id, 'sh', '-c', EXEC_SHELL]), true],
                logs,
            ],
            paused: [['start', [['unpause', id]], true], ['stop', [['stop', id]], true], logs],
            stopped: [['start', [['start', id]], true], logs],
        }[state];
        item.add_child(this._actionsBox(`container:${id}`, actions));
        return item;
    }

    /** @param {Array<[string, string[][] | Function, boolean]>} actions kind, docker commands or callback, enabled */
    _actionsBox(busyKey, actions) {
        const box = new St.BoxLayout({style_class: 'docker-folders-actions', y_align: Clutter.ActorAlign.CENTER});
        if (this._busy.has(busyKey)) {
            box.add_child(new St.Icon({icon_name: 'content-loading-symbolic', icon_size: 14}));
            return box;
        }
        for (const [kind, run, enabled] of actions) {
            const {icon, file, style, label} = ACTIONS[kind];
            const button = new St.Button({
                child: new St.Icon(file ? {gicon: this._icons[file], icon_size: 14} : {icon_name: icon, icon_size: 14}),
                style_class: `docker-folders-action docker-folders-${style}`,
                can_focus: enabled,
                reactive: enabled,
                accessible_name: label,
            });
            if (!enabled)
                button.add_style_pseudo_class('insensitive');
            button.connect('clicked', () => {
                if (typeof run === 'function') {
                    this.menu.close();
                    run();
                    return;
                }
                // Update in place: rebuilding would destroy the button inside its own click handler.
                for (const child of box.get_children()) {
                    child.reactive = false;
                    child.visible = child === button;
                }
                button.child.gicon = null;
                button.child.icon_name = 'content-loading-symbolic';
                this._runCommands(busyKey, run.filter(args => args.length > 1));
            });
            box.add_child(button);
        }
        return box;
    }

    async _runCommands(busyKey, commands) {
        this._busy.add(busyKey);
        try {
            for (const args of commands)
                await runDocker(args, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            Main.notifyError('Docker', e.message);
        }
        this._busy.delete(busyKey);
        await this._refresh();
    }

    destroy() {
        this._cancellable.cancel();
        this._eventsProc?.force_exit();
        if (this._refreshTimeoutId)
            GLib.Source.remove(this._refreshTimeoutId);
        if (this._retryTimeoutId)
            GLib.Source.remove(this._retryTimeoutId);
        super.destroy();
    }
});

export default class DockerFoldersExtension extends Extension {
    enable() {
        this._indicator = new DockerFoldersIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
