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

- **Never put `[[device]]` in `titleFormatted` when the device arg is filtered to one
  of the app's own drivers (`driver_id=...`).** Homey treats such cards as device-scoped:
  the device is shown by the device picker, NOT substituted into the title, so the store
  and app render the literal `[[device]]` (this failed certification). A card whose only
  arg is the device needs no `titleFormatted` at all — plain `title` ("Turn on") is the
  correct form, exactly like driver-level triggers/conditions. `homey app validate
  --level publish` does NOT catch this; check the store test page
  (`homey.app/…/app/<id>/test/`) to see titles as reviewers see them.

- **`"setable": false` on a system capability does NOT suppress its built-in Flow
  cards.** An `onoff` device still gets Turn on/off/toggle action cards, which fail at
  runtime if no capability listener is registered — duplicate, broken cards next to the
  app's own actions. For a read-only state, use a custom capability (e.g. `powered`)
  instead; with `"insights": true` Homey even auto-generates "…for duration" triggers.
  Existing devices need an `onInit` migration (`removeCapability`/`addCapability`).

- **Options that relax TLS verification must default to OFF for certification**, even
  when the hardware (iLO) ships with a self-signed cert and most users need it on.
  Pair it with a guided recovery: classify cert errors (undici fetch wraps the TLS error
  as `TypeError: fetch failed` with the real code on `err.cause.code`, e.g.
  `DEPTH_ZERO_SELF_SIGNED_CERT`) and offer a one-tap "allow and retry" in the pair view.

## Process

- For a Homey app, the unit-testable core is the API client (keep it Homey-free and
  inject the HTTP transport). The driver/device glue and pairing UI can only really be
  verified with `homey app run` against real hardware — budget for that round-trip.

## Publishing & git hygiene

- **Before pushing a repo public, audit git HISTORY, not just the working tree.** A
  value sanitised in the latest commit (e.g. a personal email swapped for a GitHub
  noreply) still lives in every earlier commit's blobs and is pushed with the history.
  Scrub it with `git filter-repo --replace-text` (`literal==>replacement`). `pip install`
  may be blocked (PEP 668 "externally-managed") — `git-filter-repo` is a single
  self-contained script, so `curl` it and run with `python3` instead.
- **The harness blocks creating a `--public` GitHub repo + push** as an irreversible
  public-exposure action even when the user asked for "public" earlier. Create the repo
  `--private` (reversible, reviewable) and let the human flip it with
  `gh repo edit <repo> --visibility public`, or have them run the public command themselves.
- Homey publishing: `homey app publish` uploads a *draft*; certification/submission is a
  separate manual step in the Homey Developer Tools. `verified` validation needs a
  `support` contact; `publish` needs `brandColor`.
