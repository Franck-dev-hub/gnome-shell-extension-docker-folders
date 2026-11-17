# Docker Folders

GNOME Shell extension that lists Docker containers by compose folder, from the top bar.

- **Running** tab: folders with at least one container up, with all their services.
- **Stopped** tab: folders where everything is stopped.
- Per folder: start, stop, restart.
- Per service: pause, stop, restart, open a shell, logs.
- The bar shows the number of running containers, updated live from `docker events`.

Requires GNOME Shell 50 and the `docker` CLI usable without sudo.

## Install from source

```bash
git clone https://github.com/Franck-dev-hub/docker-folders.git
ln -s "$PWD/docker-folders" ~/.local/share/gnome-shell/extensions/docker-folders@franck-dev-hub.github.io
```

Log out and back in, then `gnome-extensions enable docker-folders@franck-dev-hub.github.io`.

## Test without logging out

Needs the `mutter-dev-bin` package.

```bash
dbus-run-session gnome-shell --devkit --wayland
```

## Package for extensions.gnome.org

```bash
gnome-extensions pack --force --extra-source=icons
```

## Licence

GPL-2.0-or-later, see `LICENSE`.
