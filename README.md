# McDonald Home Organizer

Web app for finding things in storage boxes at home. Every box and shelf gets a QR label (printed on the Brother P-touch); scanning a label opens that box's photos and contents, or shows every box on that shelf. Works in any browser and can be added to the home screen on iPhone and Android.

**Hosting:** Netlify (from this GitHub repo) · **Data, sign-in, photos:** Supabase project `McDonald-Home-Organizer` (linamgjcynivkfkvghhk) · **Sign-in:** email + password; only emails on the Family list can see anything.

## One-time setup

### 1. Supabase — database
1. Supabase → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/001_setup.sql` → **Run**. A "destructive operations" warning is normal; the file is safe to run again.
3. It creates the tables, the access rules, a private `photos` storage bucket, and starting categories. The first person to sign in becomes the admin.
4. Then run `supabase/002_buildings_levels.sql` the same way. It adds buildings → rooms → shelves, shelf levels, and the building list (House, Shop, Barn, Container, Chem Shed, Pig Shed, Gun Shed, Tree House). Places made before this update are sorted in automatically.

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

### 6. First sign-in
Open the site → **First time here? Create your password** with your email → tap the link in the confirmation email → sign in. Then **More → Family members** to add the family; each person creates their own password the same way.

## Day to day
- **New box:** New box tab → pick category → number fills in (XMAS-07) → name and place → Create → add photos and contents ("Add a list" takes one item per line, `3 extension cords` or `ornaments x 24`).
- **Places:** Buildings (fixed list; only an admin adds one) → Rooms (optional: Garage, Basement, Office, Craft Room, Loft, Main Floor, or add your own) → Shelves. Small buildings can hold shelves directly. Codes build up: House › Garage › Shelf A = `HSE-GAR-A`.
- **Shelf levels:** each shelf has 1–20 levels, **1 = bottom**. The shelf gets one QR label; scanning it shows boxes level by level, top first. A box's place reads *House › Garage › Shelf A · Level 2*.
- **Labels:** shelves and boxes get labels. More → Labels to print. Copy a link into P-touch Editor (Insert → QR Code), or download the label file and use P-touch Editor's *File → Database → Connect* to print a batch (QR = *Link* column, text = *Code* column). Mark them printed.
- **Moving boxes:** open a shelf → *Scan boxes onto this shelf* → tap the level → scan box after box (tap another level any time). Or on a box → Move → pick the shelf → pick the level.
- **Pre-printed labels:** scanning a code that isn't set up yet offers to create that box.
- **Private category:** "Secure storage" (STOR) is hidden from family members unless they're allowed to see private categories (More → Family members).
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
| `supabase/001_setup.sql`, `002_buildings_levels.sql` | Database setup — run both, in order, in Supabase |
| `manifest.json`, `sw.js`, `icons/` | Home-screen app support |
| `netlify.toml` | Hosting settings (every page address opens the app) |
