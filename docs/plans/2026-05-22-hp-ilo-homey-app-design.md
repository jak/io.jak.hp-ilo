# HP iLO Homey App — Design

**App ID:** `io.jak.hp-ilo`
**Date:** 2026-05-22
**Status:** Approved

## Purpose

A Homey app that monitors and controls HPE servers through their iLO
(Integrated Lights-Out) management interface. Each paired Homey device
represents one server, surfacing its power state, power draw, temperature,
fan speed, and overall health, and allowing power control from Homey flows.

## Confirmed decisions

| Decision | Choice |
| --- | --- |
| iLO generation | iLO 5 / iLO 6 (Redfish REST API) |
| Capabilities | Power control + state, power consumption (W), temperature + fans, health status |
| Pairing | Manual entry (host/IP + username + password) |
| TLS certificates | Per-device "allow self-signed" toggle, **default on** (matches iLO out-of-box) |
| Power-off behaviour | Graceful (ACPI) shutdown by default; force-off as a separate flow action |

## Architecture

One driver, `server`, with one device per iLO interface (Approach A). The
idiomatic Homey pattern — one physical server maps to one tile.

```
io.jak.hp-ilo/
├── app.ts                      # App entry (registers nothing beyond defaults)
├── .homeycompose/
│   ├── app.json                # App manifest fragments
│   ├── capabilities/           # Custom capabilities (fan speed, health)
│   └── flow/                   # Flow card definitions
├── drivers/
│   └── server/
│       ├── driver.ts           # Pairing logic + flow card registration
│       ├── device.ts           # Polling, capability mapping, power actions
│       ├── driver.compose.json # Capabilities, settings, pair flow
│       └── pair/               # Manual-entry pairing template
├── lib/
│   └── IloClient.ts            # Redfish client (no Homey deps → unit-testable)
└── assets/                     # App + driver images
```

## Redfish client (`lib/IloClient.ts`)

Plain TypeScript with no Homey dependencies so it can be unit-tested in
isolation.

**Authentication.** Session-based. `POST /redfish/v1/SessionService/Sessions`
with credentials, cache the returned `X-Auth-Token` and session URI, reuse the
token across requests, re-authenticate once on a `401`, and `DELETE` the
session on logout. Avoids exhausting iLO's limited concurrent-session slots
(which per-request HTTP Basic auth would do under continuous polling).

**TLS.** When the device's `allowSelfSigned` setting is on, requests use a
custom `https.Agent({ rejectUnauthorized: false })`. Default on, because iLO
ships with a self-signed certificate.

**Methods.**
- `getPowerState()` — `PowerState` from `/redfish/v1/Systems/{id}`
- `setPower(resetType)` — `POST .../Systems/{id}/Actions/ComputerSystem.Reset`
  with `ResetType` ∈ {`On`, `GracefulShutdown`, `ForceOff`, `ForceRestart`, `GracefulRestart`}
- `getPower()` — watts from `/redfish/v1/Chassis/{id}/Power`
- `getThermal()` — temperatures + fans from `/redfish/v1/Chassis/{id}/Thermal`
- `getHealth()` — `Status.Health` from `/redfish/v1/Systems/{id}`

Sensors are read defensively: different servers expose different sensor sets,
so a missing sensor is skipped, never fatal. The chassis/system member id is
discovered from the collection rather than hard-coded to `1`.

## Driver (`drivers/server`)

**Pairing.** A manual-entry form collecting host/IP, username, password, and
the allow-self-signed toggle. On submit it performs a live login + read to
validate the connection before creating the device. Credentials are stored in
the device store (password never rendered back in the UI).

**Capabilities.**
- `onoff` — power on / graceful off
- `measure_power` — current draw in watts
- `measure_temperature` — inlet ambient temperature
- `measure_temperature.cpu` — CPU temperature (sub-capability)
- `measure_fan_speed` (custom, number, `%`) — highest fan speed
- `ilo_health` (custom, enum: `ok` / `warning` / `critical`)

## Device (`drivers/server/device.ts`)

- Polls every *N* seconds (per-device setting, default 30). On repeated
  failure, `setUnavailable()` with a readable reason; recovers automatically
  when the iLO responds again.
- `onoff` → ON sends `ResetType: On`; OFF sends `GracefulShutdown`.
- Force-off, warm reset, and cold boot are exposed only as flow actions, never
  the toggle, to avoid accidental hard power cuts.

## Flow cards

- **Triggers:** power turned on, power turned off (via `onoff`), health status
  changed, health became critical.
- **Conditions:** server is on, health is OK.
- **Actions:** turn on, graceful shutdown, force power off, warm reset, cold boot.

## Settings (per device)

- Poll interval (seconds, default 30)
- Allow self-signed certificate (default on)
- Host / username / password (editable)

## Error handling

- Connection errors (timeout, `ECONNREFUSED`, TLS errors) → device unavailable
  with a clear message.
- `401` → re-authenticate once; if still failing, surface "invalid credentials".
- Missing sensors → skipped, not fatal.
- Repeated poll failures → unavailable with backoff; auto-recovers.

## Testing

- Unit tests for `IloClient` against recorded/mocked Redfish JSON: happy path,
  missing-sensor, and `401` re-auth.
- `homey app validate` for manifest correctness.
- Manual `homey app run` against real hardware or a Redfish mock server.

## Scaffolding note

`homey app create` is interactive and creates a *subfolder* named after the app
ID. The scaffold must be arranged so the app lands directly in this
`io.jak.hp-ilo` directory rather than nested one level deeper.
