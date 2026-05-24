# HP iLO for Homey

Monitor and control HPE servers from Homey through their **iLO** (Integrated
Lights-Out) management interface, using the modern **Redfish** REST API.

Each paired Homey device represents one server (one iLO interface). The app
polls the iLO on an interval and exposes power state, power draw, temperature,
fan speed, and overall health — and lets you power the server on, shut it down,
reset it, or react to its health in Homey Flows.

## Supported hardware

- **iLO 5** — HPE ProLiant Gen10 / Gen10 Plus
- **iLO 6** — HPE ProLiant Gen11

Both are driven through the standardized Redfish API. The app reads sensors
defensively and falls back across firmware differences (see
[iLO 5 vs iLO 6](#ilo-5-vs-ilo-6) below), so it tolerates the variation between
firmware versions and server models.

> iLO 4 (Gen8/Gen9) is **not** a supported target. Some iLO 4 firmware speaks
> Redfish and may partially work, but it is untested.

## Capabilities

| Capability | What it shows / does |
| --- | --- |
| **Power** (`onoff`) | On = power on; Off = **graceful** OS shutdown. Also reflects current power state. |
| **Power meter** (`measure_power`) | Current power draw in watts. Reads `0` on hardware without power metering — see note below. |
| **Inlet temperature** (`measure_temperature`) | Inlet/ambient temperature (°C). |
| **CPU temperature** (`measure_temperature.cpu`) | **Hottest** CPU sensor (max of all sensors with Redfish `PhysicalContext: CPU`), i.e. the worst-case / closest-to-throttling reading. |
| **Fan speed** (`measure_fan_speed`) | Highest fan speed (%). |
| **Health** (`ilo_health`) | Overall server health: OK / Warning / Critical. |

> **Power metering:** entry-level servers (e.g. HPE ProLiant ML110 Gen10) don't
> include power-draw metering hardware. On those, iLO reports
> `PowerConsumedWatts: 0`, so the power tile shows **0 W** — this is the server's
> actual response, not an error. Models with metered/redundant power supplies
> report real wattage.

### Flow cards

- **Triggers:** server power turned on / off (built-in via the power capability);
  *Health status changed* (with a `health` token); *Health became critical*.
- **Conditions:** *Server is powered on*; *Health is OK*.
- **Actions:** *Turn on*, *Graceful shutdown*, *Force power off*, *Restart (warm)*,
  *Cold boot (force restart)*.

The Homey on/off toggle deliberately performs a **graceful** shutdown. The
abrupt options (force off, cold boot) are only available as explicit Flow
actions, so you can't accidentally hard-cut a running server from the tile.

## Pairing

Add a device → **HP iLO** → **HPE Server (iLO)**, then enter:

- **Host / IP** — the iLO interface address (e.g. `192.168.1.50`)
- **Username** / **Password** — an iLO account
- **Allow self-signed certificate** — on by default (see below)

Pairing performs a live login and read against the iLO before creating the
device, so bad credentials or an unreachable host are reported immediately.
Credentials are stored in the device's internal store (not shown in the UI).

## Self-signed certificates

iLO ships with a **self-signed TLS certificate** by default, which Node would
otherwise reject. The *Allow self-signed certificate* option (on by default,
per-device, editable in device settings) accepts it. If you have installed a
properly trusted certificate on your iLO, turn this off for strict validation.

## Settings (per device)

- **Host / IP** — editable after pairing.
- **Allow self-signed certificate** — see above.
- **Poll interval** — how often to query the iLO (seconds, default 30, range 10–3600).

## How it works

- `lib/IloClient.ts` — a Homey-independent Redfish client: session-based auth
  (`X-Auth-Token`, reused across requests, re-authenticated once on `401`, and
  released on logout), bounded retry on transient `503`/`429`, and defensive
  parsing of power/thermal/health resources. Because it has no Homey
  dependencies, it is fully unit-tested in isolation.
- `drivers/server/` — the Homey driver: manual-entry pairing, the device that
  polls `IloClient` and maps results to capabilities (logging out of the iLO
  session on teardown so sessions aren't leaked), and the Flow cards.

### How sensor values are selected

Each tile distills a single value from what may be many Redfish sensors. The
selection rules, and why:

- **Power state & control.** The on/off tile reflects `PowerState` (`On`/`Off`;
  transitional `PoweringOn`/`PoweringOff` are ignored until settled). Toggling
  **off sends a graceful ACPI shutdown** (`GracefulShutdown`), never a hard cut —
  the destructive variants (force off, cold boot) are reachable only as explicit
  Flow actions, so the tile can't accidentally kill a running server. Every reset
  is validated at runtime against the iLO's advertised
  `ResetType@Redfish.AllowableValues` before it is sent.
- **Power draw (W).** `…/Chassis/{id}/Power` → `PowerControl[0].PowerConsumedWatts`.
  Models without metering hardware report `0` (see the note under Capabilities).
- **Inlet temperature.** The intake/ambient sensor — identified by
  `PhysicalContext: "Intake"`, or a sensor whose name contains "Inlet Ambient" —
  i.e. the temperature of air entering the chassis, the standard ambient reference.
- **CPU temperature — the *hottest* sensor.** A server can expose several CPU
  sensors (dual-socket → P1/P2, sometimes package + per-area). The tile reports
  the **maximum** `ReadingCelsius` across all sensors with `PhysicalContext: "CPU"`.
  Rationale: for one tile the worst-case CPU is the meaningful one — it's closest
  to the thermal/throttling limit, so a "CPU too hot" Flow triggers on the right
  value. Averaging would mask a single hot socket/core.
- **Fan speed (%) — the *highest* fan.** Servers run many fans at independent
  speeds. The tile reports the **maximum** across all fans reporting in percent
  (`ReadingUnits: "Percent"`). Rationale: the busiest fan reflects the system's
  current cooling effort / thermal stress; an average would understate how hard
  the cooling is working. (iLO reports fan speed as a percentage, not RPM.)
- **Health.** Uses `Status.HealthRollup` — the **aggregated** health of the system
  and all subcomponents — falling back to `Status.Health` when no rollup is
  present, mapped to `OK` / `Warning` / `Critical`. The rollup means a fault in any
  subsystem (PSU, memory, drive, …) surfaces on the single Health tile.

Missing sensors are skipped, never fatal: a sensor a given server doesn't expose
simply leaves its capability un-updated rather than erroring or showing a bogus value.

### iLO 5 vs iLO 6

The client targets resources both firmwares support and falls back across their
differences (the *selection* of which value to show is covered above):

- **Power draw:** prefers the legacy `…/Chassis/{id}/Power` resource, falling back
  to `…/EnvironmentMetrics` → `PowerWatts.Reading` on firmware that omits it.
- **Thermal:** reads `…/Chassis/{id}/Thermal`, matching sensors defensively by
  `PhysicalContext`/name so enum values deprecated across firmware don't break it.
- **Discovery:** the System and Chassis member URIs are discovered from their
  collections rather than assuming `/1` (chassis ids in particular vary by model).

## Development

```bash
npm install          # install dev dependencies
npm test             # unit tests (Mocha + Chai) for the Redfish client
npm run test:coverage # unit tests with a coverage report (c8)
npm run build        # tsc → .homeybuild/
npm run lint         # eslint
homey app validate --level publish   # manifest validation
homey app run        # run live on a connected Homey (see below)
```

`homey app run` requires a Homey on your network (and Homey developer login)
plus a reachable iLO to pair against.

## Publishing to the Homey App Store

The app passes `homey app validate --level verified` (the strictest level). To
publish (requires a Homey developer account):

```bash
homey login                       # authenticate the CLI
homey app validate --level publish
homey app publish                 # bumps version, prompts for a changelog, uploads a draft
```

`homey app publish` uploads a **draft** to the
[Homey Developer Tools](https://tools.developer.homey.app/). From there, submit
the draft for Athom's certification review; once approved it goes live in the
store. The manifest already carries the store metadata (brand colour, category,
author, support/source/bugs URLs) and artwork.

## Verification status

- **Unit-tested:** all `IloClient` logic — auth, 401 re-auth, transient retry,
  member discovery, power state, power control with allowable-value validation,
  power-draw fallback, thermal parsing, health, and the pairing probe — via an
  injected HTTP transport and Redfish-shaped fixtures.
- **Validated:** the Homey manifest passes `homey app validate` at `debug` and
  `publish` levels.
- **Confirmed on real hardware** (`homey app run` against a live **iLO 5, HPE
  ProLiant ML110 Gen10**): pairing and the production HTTP transport (global
  `fetch` + an `undici` agent for self-signed TLS); session login and the
  self-signed-cert path; and the periodic poll — power state, inlet/CPU
  temperatures and fan speed all read correctly, and power draw is reported
  faithfully (0 W on this non-metered model).
- **Not yet independently confirmed on hardware:** the power-control actions
  (graceful shutdown / force off / reset). These use the same unit-tested client
  path as the reads, but are destructive, so they were not exercised — verify
  before relying on power control in automations. The `verified` validation
  level additionally requires a `support` contact, which is intentionally left
  unset.

## Design & plan

- Design: [`docs/plans/2026-05-22-hp-ilo-homey-app-design.md`](docs/plans/2026-05-22-hp-ilo-homey-app-design.md)
- Implementation plan: [`docs/plans/2026-05-22-hp-ilo-homey-app.md`](docs/plans/2026-05-22-hp-ilo-homey-app.md)

## License

GPL-3.0 (standard Homey app license).
