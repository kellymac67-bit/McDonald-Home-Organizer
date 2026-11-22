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


## Monnit sensors without the internet (Ethernet Gateway 4)
If your Monnit gateway is an **ALTA Ethernet Gateway 4**, the bridge can read the sensors straight from it over your home network every minute. It keeps working when the internet is down.
1. In iMonnit, go to **Gateways**, pick your gateway, then **Settings → Interface** and turn on **Activate MODBUS Interface**. Save; it takes effect at the gateway's next check-in.
2. Give the gateway a fixed address. In the Orbi, use **Address Reservation**.
3. On the bridge's **Configuration** tab, put the gateway's IP address in **monnit_gateway_ip**, then save and restart.
For the first 15–30 minutes the bridge learns how to read each sensor by comparing the gateway's raw numbers with iMonnit's readings. After that it uses the local numbers whenever they're newer. Water sensors (on/off) still come from iMonnit for now.

## SolarEdge solar (local Modbus)

SolarEdge retired its old cloud API in November 2026, so the cloud SolarEdge integration no longer gets readings.
Use Home Assistant's **SolarEdge Modbus** integration instead (Home Assistant 2026.10+): turn on Modbus TCP on the
inverter (red switch to P for 1–2 s, join its Wi-Fi, open 172.16.0.1 → Site Communication → Modbus TCP, port 1502),
then add the integration with the inverter's IP, port 1502, device ID 1. A follower inverter is read through the
leader with the same IP and device ID 2. The bridge (0.9.3+) sends each inverter's AC power and lifetime energy;
the app adds them up and works out "today" from the history it records every 10 minutes.

### Solar alerts (0.9.4+)
The bridge saves an automation **Alert: Solar inverters** that sends a phone alert when, in daylight:
- an inverter is at 0 W for 30 minutes while the other one is making over 1 kW,
- an inverter stops answering for 30 minutes,
- every inverter is at 0 W for an hour (sun more than 15° up), or
- an inverter's Problem sensor stays on for 10 minutes.
It also makes a **Solar alerts** switch (More > Alert settings) to pause them.

### Camera battery alerts (0.9.8+)
**Alert: Camera batteries** sends a phone alert when a battery camera (Ring) is below 20% for 10 minutes, and again below 10%.
Pause with the **Battery alerts** switch (More > Alert settings).

### Generator outage boost (0.9.10+, needs the Generac integration 0.6.0+)
**Generator: Outage boost** asks Mobile Link for updates every 2 minutes for 30 minutes when Sense stops reporting
or reads under 20 W, or when Home Assistant starts (a power outage restarts the Pi).

### Near-live view (1.0.1+)
For cameras without Ring's own live video (Kasa through Scrypted, Tapo…), the app's **▶ Live** button asks the bridge to send
a fresh picture about once a second to `cams/<camera>/live.jpg` while someone is watching. The app re-asks every minute;
the bridge stops 90 s after the last ask (or right away when the viewer taps Stop), and the app stops after 5 minutes.

### Off timers (1.0.2+, run supabase/014_off_timers.sql once)
Lights tab → **⏲ Timer** on any room (e.g. Tree House) → pick 15 min … 4 hours (or any number of minutes, up to 24 h) and
which lights/switches. The bridge keeps the timer in `/data/off_timers.json` (survives a restart), turns those devices off
when it ends, and lists active timers in `ha_bridge_status.timers` so the app shows a countdown with **Change** / **Cancel**.
