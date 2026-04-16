# Cloud Clipboard

A realtime cloud clipboard using:
- Firebase Realtime Database for sync, history, and presence
- Supabase Storage for image and file uploads

## Local setup

1. Create `firebase-config.js` by copying the example:
   - Copy `firebase-config.example.js` -> `firebase-config.js`
   - Paste your Firebase Web App config into `firebase-config.js`

2. Create `supabase-config.js` by copying the example:
   - Copy `supabase-config.example.js` -> `supabase-config.js`
   - Paste your Supabase values into `supabase-config.js`

3. Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Supabase setup

1. Create a Supabase project.
2. Open `Storage`.
3. Create a bucket named `clipboard-assets`.
4. Mark the bucket as `Public`.
5. Open `Project Settings` -> `API`.
6. Copy:
   - Project URL
   - anon public key
7. Put those into `supabase-config.js`.
8. Add storage policies so the browser can upload to the bucket.

For a quick demo setup, these SQL policies work:

```sql
create policy "clipboard_assets_public_read"
on storage.objects
for select
to public
using (bucket_id = 'clipboard-assets');

create policy "clipboard_assets_public_insert"
on storage.objects
for insert
to public
with check (bucket_id = 'clipboard-assets');

create policy "clipboard_assets_public_update"
on storage.objects
for update
to public
using (bucket_id = 'clipboard-assets')
with check (bucket_id = 'clipboard-assets');
```

If uploads fail with a row-level security error, the bucket policy is the first thing to check.

## Deploy (Firebase Hosting)

```bash
npx -y firebase-tools@latest deploy --only hosting
```

