# McDonald Home Organizer

Web app for finding things in storage boxes at home. Every box and shelf gets a QR label (printed on the Brother P-touch); scanning a label opens that box's photos and contents, or shows every box on that shelf. Works in any browser and can be added to the home screen on iPhone and Android.

**Hosting:** Netlify (from this GitHub repo) · **Data, sign-in, photos:** Supabase project `McDonald-Home-Organizer` (linamgjcynivkfkvghhk) · **Sign-in:** emailed code; only emails on the Family list get in.

## One-time setup

### 1. Supabase — database
1. Supabase → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/001_setup.sql` → **Run**. A "destructive operations" warning is normal; the file is safe to run again.
3. It creates the tables, the access rules, a private `photos` storage bucket, starting categories, and adds kellymac67@gmail.com as admin.

### 2. Supabase — sign-in emails send a code
1. **Authentication → Emails → Templates → Magic Link** (sometimes called "Magic link / OTP").
2. Replace the body with:
   ```html
   <h2>Home Organizer sign-in</h2>
   <p>Your code is: <strong style="font-size:24px">{{ .Token }}</strong></p>
   <p>Enter it in the app. It expires in one hour.</p>
   ```
3. Do the same in the **Confirm signup** template (used the first time each person signs in).
4. Save.

### 3. App key
In `js/config.js`, `SUPABASE_KEY` must hold the project's **publishable** key (`sb_publishable_…`) or **anon** key (`eyJ…`) from **Project Settings → API Keys**. Never the secret / service_role key.

### 4. Netlify
1. **Add new site → Import an existing project → GitHub** → pick `McDonald-Home-Organizer`.
2. Leave the build command empty; publish directory `.` (already set in `netlify.toml`). **Deploy**.
3. **Site configuration → Change site name** → e.g. `mcdonald-home-organizer` → the app lives at `https://mcdonald-home-organizer.netlify.app`.

### 5. Supabase — allow the site address
**Authentication → URL Configuration**: set **Site URL** to the Netlify address and add `https://<your-site>.netlify.app/**` under **Redirect URLs**.

### 6. First sign-in
Open the site, enter kellymac67@gmail.com, type the emailed code. Then **More → Family members** to add the family. Each person signs in with their own email.

## Day to day
- **New box:** New box tab → pick category → number fills in (XMAS-07) → name and place → Create → add photos and contents ("Add a list" takes one item per line, `3 extension cords` or `ornaments x 24`).
- **Places:** nest them (Garage › Shelf A › Top). Codes like `GAR-A1` read well on a label.
- **Labels:** More → Labels to print. Copy a link into P-touch Editor (Insert → QR Code), or download the label file and use P-touch Editor's *File → Database → Connect* to print a batch (QR = *Link* column, text = *Code* column). Mark them printed.
- **Moving boxes:** open a shelf → *Scan boxes into here* → scan box after box. Or on a box → Move.
- **Pre-printed labels:** scanning a code that isn't set up yet offers to create that box.
- **Private category:** "Secure storage" (STOR) is hidden from family members unless they're allowed to see private categories (More → Family members).
- **Backup:** More → Download everything (spreadsheet).

## Notes
- Supabase's built-in email sender is limited to a few emails per hour. Fine for a family (people stay signed in), but if codes stop arriving, add a custom SMTP sender (e.g. Resend) under Authentication → Emails → SMTP settings.
- Free Supabase projects pause after a week with no use; open the dashboard and click Restore if that happens.
- Photos are shrunk on the phone before upload (about 300 KB each), so the free 1 GB holds thousands.

## Files
| File | What it is |
|---|---|
| `index.html`, `app.css`, `js/app.js` | The app |
| `js/config.js` | Supabase address and key |
| `supabase/001_setup.sql` | Database setup (run once in Supabase) |
| `manifest.json`, `sw.js`, `icons/` | Home-screen app support |
| `netlify.toml` | Hosting settings (every page address opens the app) |
