# TODO

- [ ] **Check per-monitor wallpapers in a normal run** (installed app / autostart): each monitor should get its own
  photo; the log must not contain "per-monitor wallpaper failed".
- [ ] **Check the lock screen option** (Settings → Fit to screen → "Also set the lock screen"); it was never run.
- [ ] **Check autostart points to the installed exe** (`%LOCALAPPDATA%\Programs\Immich Wallpaper`), not to
  `release\win-unpacked`.

## Decisions

- Auto-update (0.3.0+): electron-updater reads `latest.yml` from the public GitHub releases, checks a minute after
  start and every 6 hours, downloads in the background and installs on quit or via "Restart to update".
  The repository was made public for this (no token in the app); commit emails were rewritten to the GitHub
  noreply address before that. Versions before 0.3.0 have no updater: install 0.3.0 by hand once.
- HEIC: converted locally from the original (heic-decode/WASM); Immich's full-size generation can stay off.
  RAW is not handled: the library has no RAW files.
