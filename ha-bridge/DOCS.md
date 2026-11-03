# McDonald Home Bridge

Connects Home Assistant to the McDonald Home Organizer app **without opening anything at home to the internet**. The add-on only makes outgoing connections to the app's Supabase database.

## What it sends
- Only devices that have an **Area** in Home Assistant. A device with no area (for example the Salem Center cameras on the same Ring account) is never sent. To add or remove something from the app, set or clear its Area in Home Assistant.
- Cameras, switches, lights, locks, garage doors/covers, thermostats (Google Nest), temperature/humidity/moisture sensors, and door/window/motion/leak sensors. Settings and diagnostic entities are skipped.
- Camera snapshots: every 15 minutes for plugged-in cameras (battery cameras: only on motion or when asked, to save battery), on motion (at most one every 5 minutes per camera), and when someone taps *Refresh* in the app. Motion snapshots are deleted after `keep_snapshot_days`.

## What it accepts from the app
- Switch and light **on / off / toggle**, **take a snapshot**, **lock / unlock** and **open / close** (only for people allowed to use doors), scenes, and **thermostat changes** (temperature, mode, Eco — only for people with *Can control*). Sirens can't be operated from the app.
- Commands older than 2 minutes are ignored (so a "turn on" sent while the house was offline doesn't fire hours later).

## Options
| Option | Meaning |
|---|---|
| `supabase_url`, `supabase_key` | The app's Supabase address and *publishable* key (already filled in). Never the secret key. |
| `bridge_email` | The bridge's own sign-in for the app — must match the user created in Supabase. |
| `bridge_password` | That user's password. Stored only on the Pi. |
| `motion_snapshots` | Take a snapshot when a camera sees motion. |
| `keep_snapshot_days` | How long motion snapshots are kept (1–14). |

## Checking it works
Open the **Log** tab. You should see *Signed in to the app database*, *Connected to Home Assistant* and a *Device list:* line with counts.
