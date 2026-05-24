# Lessons

Reusable lessons learned while building this app. Read at the start of a session; add a rule whenever a mistake is corrected.

## Homey app development

- **Custom pairing views: run the script at top level — do NOT rely on `onHomeyReady`.**
  Homey does not reliably auto-invoke `function onHomeyReady(Homey){…}` in a custom
  *pairing* view (it does for *settings* views, which load `/homey.js`). Symptom: the
  view's HTML renders but the script never runs — buttons are inert, no `Homey.emit`
  reaches the driver, and there is no console error. Fix: the global `Homey` object is
  already injected, so attach listeners and call `Homey.emit` directly at top level
  (see `drivers/server/pair/login.html` and the working `io.jak.givenergy` pair views).
  `Homey.ready()` is a settings-view signal and is not needed for pairing.

- **`homey app run` hot-reloads view HTML but NOT `app.json` / the pair manifest.**
  After changing `driver.compose.json` (capabilities, settings, `pair` navigation) or
  custom capabilities, you must Ctrl-C and restart `homey app run` for the change to
  take effect. HTML/CSS edits to pair views appear to reload; manifest changes do not.

- **Driver images must be square; app images are 16:11-ish.**
  `publish`-level validation requires driver images at **75×75 / 500×500 / 1000×1000**.
  App images are **250×175 / 500×350 / 1000×700**. `debug` validation does not check this.

- **`brandColor` is required for `publish` (not `debug`); `support` is required for `verified`.**

- **Keep test/dev files out of the published bundle two ways:** `tsconfig.json` must
  `exclude: ["test", …]` (so `tsc` doesn't emit specs into `.homeybuild/`), AND a
  `.homeyignore` (gitignore syntax) must list `test/`, `docs/`, `task/`. Homey already
  ignores `*.ts`, `tsconfig.json`, dotfiles and `node_modules` by default.

- **TypeScript scaffold pins matter:** the SDK v3 `module.exports = class extends Homey.X`
  pattern needs TypeScript `^5` and `@types/node` `^16`. TS 6 defaults
  `moduleDetection: "force"` (treats files as ESM), breaking the CommonJS `module` global.

- **Redfish/iLO transport:** Homey's runtime has global `fetch`; use an `undici.Agent`
  via the `dispatcher` option for self-signed TLS, and always set a request timeout
  (`AbortSignal.timeout`) — a probe against an unreachable host otherwise hangs forever
  with no UI feedback.

## Process

- For a Homey app, the unit-testable core is the API client (keep it Homey-free and
  inject the HTTP transport). The driver/device glue and pairing UI can only really be
  verified with `homey app run` against real hardware — budget for that round-trip.
