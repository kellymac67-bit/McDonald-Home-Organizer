# McDonald Home Organizer

Web app for finding things in storage boxes at home. Every box and shelf gets a QR label (printed on the Brother P-touch); scanning a label opens that box's photos and contents, or shows every box on that shelf. Works in any browser and can be added to the home screen on iPhone and Android.

**Hosting:** Netlify (from this GitHub repo) · **Data, sign-in, photos:** Supabase project `McDonald-Home-Organizer` (linamgjcynivkfkvghhk) · **Sign-in:** email + password; only emails on the Family list can see anything.

## One-time setup

### 1. Supabase — database
1. Supabase → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/001_setup.sql` → **Run**. A "destructive operations" warning is normal; the file is safe to run again.
3. It creates the tables, the access rules, a private `photos` storage bucket, and starting categories. The first person to sign in becomes the admin.
4. Then run `supabase/002_buildings_levels.sql` the same way. It adds buildings → rooms → shelves, shelf levels, and the building list (House, Shop, Barn, Container, Chem Shed, Pig Shed, Gun Shed, Tree House). Places made before this update are sorted in automatically.
5. Then run `supabase/003_subcategories.sql`. It adds main categories with sub-categories: Decorations › Christmas, Spring, Easter, July 4th, Halloween, Fall, Thanksgiving. "Christmas decorations" becomes Decorations › Christmas (boxes keep XMAS numbers); "Other seasonal" is removed if empty, otherwise parked as *Other seasonal (to sort)* until its boxes are moved.

### 2. Supabase — sign-in
Nothing to change. Sign-in is email + password. The first time, each person taps **First time here? Create your password**, then taps the link in Supabase's standard confirmation email once. **Forgot password?** emails a reset link.

### 3. App key
In `js/config.js`, `SUPABASE_KEY` must hold the project's **publishable** key (`sb_publishable_…`) or **anon** key (`eyJ…`) from **Project Settings → API Keys**. Never the secret / service_role key.

### 4. Netlify
1. **Add new site → Import an existing project → GitHub** → pick `McDonald-Home-Organizer`.
2. Leave the build command empty; publish directory `.` (already set in `netlify.toml`). **Deploy**.
3. **Site configuration → Change site name** → e.g. `mcdonald-home-organizer` → the app lives at `https://mcdonald-home-organizer.netlify.app`.

### 5. Supabase — allow the site address
**Authentication → URL Configuration**: set **Site URL** to the Netlify address and add `https://<your-site>.netlify.app/**` under **Redirect URLs**.

### 6. Home Assistant bridge (cameras, switches, sensors)
1. Supabase → SQL Editor → run `supabase/004_home_devices.sql`, then `005_device_areas.sql`, `006_locks.sql`, `007_garage.sql` and `008_scenes.sql` (adds door lock and garage door control, scenes and each person's Home screen, HA-area linking, the Chicken Coop building, and Basement / Garage / Man Cave rooms under House).
2. Supabase → **Authentication → Users → Add user → Create new user**: email `ha-bridge@mcdonald-home.app`, a long random password, tick **Auto Confirm User**. This account can't see any boxes; it can only send device info and pick up commands.
3. Home Assistant → **Settings → Apps → Install app** → ⋮ → **Repositories** → add `https://github.com/kellymac67-bit/mcdonald-home-organizer` → install **McDonald Home Bridge**.
4. Add-on **Configuration** tab → paste the bridge password into `bridge_password` → Save → **Info** tab → turn on *Start on boot* and *Watchdog* → **Start**. The **Log** tab should show *Signed in*, *Connected to Home Assistant* and a device count.
5. **Monnit:** iMonnit Online → **API → API Keys → Generate Key** (name it *Home Bridge*; the secret is shown only once). Paste the Key ID and Secret into `monnit_api_key_id` / `monnit_api_secret` on the add-on's Configuration tab and restart it. Sensors appear in the app within a minute and in Home Assistant as `sensor.monnit_…` (for automations). Place them under **More → Home devices** (tap a sensor → Building or room).
6. Only devices with an **Area** in Home Assistant appear. An area named like a building or room in the app (Barn, Shop, Garage…) is linked to it automatically.
7. Admins can see cameras and use switches. Other family members need *See cameras* / *Use switches* turned on.

**Updating the bridge:** Settings → Apps → **Install app** → ⋮ → **Check for updates** → McDonald Home Bridge → **Update**. (Newer Home Assistant calls add-ons "Apps".)

### 7. First sign-in
Open the site → **First time here? Create your password** with your email → tap the link in the confirmation email → sign in. Then **More → Family members** to add the family; each person creates their own password the same way.

## Day to day
- **New box:** New box tab → pick category → number fills in (XMAS-07) → name and place → Create → add photos and contents ("Add a list" takes one item per line, `3 extension cords` or `ornaments x 24`).
- **Places:** Buildings (fixed list; only an admin adds one) → Rooms (optional: Garage, Basement, Office, Craft Room, Loft, Main Floor, or add your own) → Shelves. Small buildings can hold shelves directly. Codes build up: House › Garage › Shelf A = `HSE-GAR-A`.
- **Shelf levels:** each shelf has 1–20 levels, **1 = bottom**. The shelf gets one QR label; scanning it shows boxes level by level, top first. A box's place reads *House › Garage › Shelf A · Level 2*.
- **Labels:** shelves and boxes get labels. More → Labels to print. Copy a link into P-touch Editor (Insert → QR Code), or download the label file and use P-touch Editor's *File → Database → Connect* to print a batch (QR = *Link* column, text = *Code* column). Mark them printed.
- **Moving boxes:** open a shelf → *Scan boxes onto this shelf* → tap the level → scan box after box (tap another level any time). Or on a box → Move → pick the shelf → pick the level.
- **Pre-printed labels:** scanning a code that isn't set up yet offers to create that box.
- **Categories:** main category › sub-category (Decorations › Halloween). Boxes go in a sub-category, or in a main category that has no subs; the box number uses that prefix (HALL-03). On Search, tap a main category chip and a second row of sub-category chips appears. Admin: More → Categories → *＋ Main category* / *＋ Sub-category*.
- **Private category:** "Secure storage" (STOR), and any sub-category under it, is hidden from family members unless they're allowed to see private categories (More → Family members).
- **Five tabs:** **Home** (your own everyday screen: alerts, doors, scenes, up to 8 *At a glance* readings, a *Weather* button, two cameras, recent boxes — set it up with *Edit*), **Lights** (all scenes, every light by room, *All off*), **Cameras**, **Organizer** (search, *Scan label*, *New box*, *Labels*, buildings → rooms → shelves → boxes) and **More**. Scanning a box or shelf QR label still opens it straight away.
- **Scenes:** Lights → *＋ New scene* (or tap a scene's name to edit). *On and Off* scenes switch a group together; *One button* scenes mix on and off (like Good night). Optional: lock the front door / close the garage, and a schedule (a time, or sunset/sunrise ± minutes, chosen days). Scenes are shared by the family; each person picks which appear on their Home. The bridge saves every scene into Home Assistant as a script (`Scene: …`) and each schedule as an automation (`Schedule: …`), so schedules run on the Pi even without internet — edit them in the app, not in Home Assistant.
- **Weather:** Home → *Weather* shows every reading from the Ambient station (Ambient Weather Station integration in Home Assistant; give the station an Area).
- **Cameras:** tap one for its latest picture, *Take a new picture*, recent motion pictures and *Live in Ring*. Building pages show their own devices too.
- **Door locks:** *Lock* works right away; *Unlock* asks to confirm, expires if the house doesn't act within 30 seconds, and sends a phone alert saying who did it. The **garage door** works the same way (*Open* / *Close*, both confirmed, phone alert each time). Only admins and people with *Can lock/unlock doors and open the garage* see the buttons.
- **Home devices (admin, under More):** link each Home Assistant area to a building or room, hide clutter, rename devices, and set how often each camera takes a picture.
- **Backup:** More → Download everything (spreadsheet).

## Notes
- Supabase's built-in email sender is limited to a few emails per hour. If confirmation or reset emails stop arriving, wait an hour, or add a custom SMTP sender under Authentication → Emails → SMTP settings.
- Free Supabase projects pause after a week with no use; open the dashboard and click Restore if that happens.
- Photos are shrunk on the phone before upload (about 300 KB each), so the free 1 GB holds thousands.

## Files
| File | What it is |
|---|---|
| `index.html`, `app.css`, `js/app.js` | The app |
| `js/config.js` | Supabase address and key |
| `supabase/001_setup.sql` … `008_scenes.sql` | Database setup — run all, in order, in Supabase |
| `repository.yaml`, `ha-bridge/` | Home Assistant add-on that connects the house to the app (see `ha-bridge/DOCS.md`) |
| `manifest.json`, `sw.js`, `icons/` | Home-screen app support |
| `netlify.toml` | Hosting settings (every page address opens the app) |

## Ring live view
Live video for the home Ring cameras goes through the Supabase Edge Function `ring` (supabase/functions/ring/index.ts). The function only lets through cameras that also appear in the app from Home Assistant, so the Salem Center cameras on the same Ring account can't be opened.
1. In the Ring developer console, create a private app called "McDonald Home Cameras" with Cameras and Doorbells turned on. Put its keys in Supabase under Edge Functions → Secrets as `RING_CLIENT_ID`, `RING_CLIENT_SECRET` and `RING_HMAC_KEY`.
2. Run `supabase/009_ring.sql`. Then deploy the function under the name `ring` and turn **Verify JWT** off.
3. Give Ring these addresses:
   - Token Exchange: `https://linamgjcynivkfkvghhk.supabase.co/functions/v1/ring/token`
   - Webhook: `…/functions/v1/ring/webhook`
   - Account Link: `https://mcdonald-home-organizer.netlify.app/ring-link.html`
4. Allow the app from the Ring app. More → Home devices → Ring live view should then show the connected cameras, and each Ring camera gets a ▶ Live button.

## Thermostat (Google Nest)
The Nest thermostat reaches Home Assistant through the Google Nest integration. That setup uses the Google Cloud project HA-Google-Home and a Device Access project ($5, one time). Its Pub/Sub topic is set in the Device Access Console.
1. Run `supabase/010_thermostat.sql` before updating the bridge to 0.5.0. Until it's run, the bridge leaves the thermostat out.
2. Update the McDonald Home Bridge app in Home Assistant to 0.5.0.
3. The thermostat shows at the top of **At a glance** on Home. Use − and ＋ to change the set temperature, or tap the thermostat for the mode (Heat, Cool, Heat·Cool, Off) and Eco. Changing it requires *Can control*.
- **Too cold / too hot phone alerts:** run `supabase/011_thermostat_alerts.sql` and update the bridge to 0.5.1. Both alerts start at 60° and 78°. An admin changes them by tapping the thermostat and using **Phone alerts**. The bridge saves them in Home Assistant as the automation "Alert: … too cold / too hot", and it fires after 10 minutes past the limit. The phone the alerts go to is the bridge option `alert_notify`; several can be listed, separated by commas.
- **Emergency heat:** Google doesn't allow it from other apps, so the button opens the Google Home app.
