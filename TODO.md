# TODO

- [ ] **Check per-monitor wallpapers in a normal run** (installed app / autostart): each monitor should get its own
  photo; the log must not contain "per-monitor wallpaper failed".
- [ ] **Check the lock screen option** (Settings → Fit to screen → "Also set the lock screen"); it was never run.
- [ ] **Check autostart points to the installed exe** (`%LOCALAPPDATA%\Programs\Immich Wallpaper`), not to
  `release\win-unpacked`.

## Decisions

- Auto-update: not planned. New versions are built by GitHub Actions (bump `version`, push to `master`) and
  installed by running the release's installer over the old one.
- HEIC: converted locally from the original (heic-decode/WASM); Immich's full-size generation can stay off.
  RAW is not handled: the library has no RAW files.
