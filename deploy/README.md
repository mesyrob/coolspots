# Deploying CoolSpots to Talos K8s

Self-hostable on your homelab. Runs as a single PocketBase pod with one PVC for SQLite data and two ConfigMaps for static assets + DB migrations.

## What gets deployed

| Resource              | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `Namespace coolspots` | Isolation.                                                    |
| `PVC coolspots-data`  | 1Gi local-path. SQLite file + uploads live here.              |
| `ConfigMap coolspots-public` (generated) | Frontend: index.html, app.js, styles.css, etc. |
| `ConfigMap coolspots-migrations` (generated) | PB schema + OSM seed migration files.       |
| `Deployment coolspots`| 1 replica of `ghcr.io/muchobien/pocketbase:0.22.20`. `strategy: Recreate` (SQLite single-writer). |
| `Service coolspots`   | ClusterIP `:80` → pod `:8090`.                                |
| `Ingress coolspots`   | `coolspots.home` → service. Class `nginx`.                    |

## First deploy (manual)

The kustomization references files outside its own directory (`../index.html` etc.), so you need to bypass kustomize's default load restriction. `kubectl apply -k` doesn't expose that flag — use `kustomize` directly:

```bash
# From the project root (~/ws/coolspots):
brew install kustomize  # if you don't have it
kustomize build deploy/ --load-restrictor=LoadRestrictionsNone | kubectl apply -f -

# Wait for the pod to come up — first boot runs both migrations
# (creates the spots collection, seeds 51 OSM Leuven venues).
kubectl -n coolspots get pods -w
```

Then open <http://coolspots.home> on a machine that resolves `.home` to your cluster's ingress IP. The admin UI lives at <http://coolspots.home/_/> — set the admin email/password on first visit.

## GitOps via ArgoCD

The kustomization references files outside its own directory (`../index.html` etc.), so the Argo Application needs `LoadRestrictionsNone`:

```yaml
spec:
  source:
    kustomize:
      buildOptions: --load-restrictor=LoadRestrictionsNone
```

A ready-to-use Application manifest is at `argocd-application.yaml` — drop it into your homelab-k8s repo at `apps/workloads/coolspots.yaml`, adjust `repoURL` to wherever you push this project, commit & push. Argo picks it up automatically.

## Re-importing OSM venues

```bash
node scripts/import-osm.js leuven    # also: brussels, antwerp, ghent
git commit -am "Re-import OSM venues"
git push                              # ArgoCD redeploys
```

The importer regenerates both `seed.js` (offline fallback) and `deploy/pb_migrations/1700000002_seed_osm.js`. The seed migration is **idempotent** — it skips inserting if the `spots` collection already has rows. To force a re-seed: open the admin UI, delete all `source=osm` records, then restart the pod.

## How the frontend talks to PocketBase

- On page load `app.js` calls `GET /api/collections/spots/records` (paginated, fetches all pages).
- Adding a spot → `POST /api/collections/spots/records`.
- Voting → `PATCH /api/collections/spots/records/{id}` with the new `confirms`/`denies` totals.
- If any of those fail (e.g. dev mode against `python3 -m http.server`), the app silently falls back to bundled `seed.js` and writes to localStorage instead.

- Favorites → `GET/POST/DELETE /api/collections/favorites/records` scoped to this device's UUID (see next section).

## How favorites work (anonymous device identity)

There's no login. On first visit the browser generates a UUID via `crypto.randomUUID()`, stores it in localStorage as `coolspots:device-id`, and sends it with every favorite API call.

```
┌──────────────┐                              ┌─────────────────────┐
│  browser     │   POST /favorites            │  PocketBase         │
│  device-id:  │ ───────────────────────────▶ │  favorites table:   │
│  abc-123     │   { device_id: "abc-123",    │  (device_id, spot)  │
│              │     spot: "rec_xyz" }        │  UNIQUE constraint  │
└──────────────┘                              └─────────────────────┘
```

The `favorites` collection has API rules `device_id = @request.query.device_id` on list/view/delete, so a client can only see and delete its own favorites. **There's no real security here** — any client can pass any device_id. It's "security through obscurity" suitable for a homelab demo, not a public app. Replace with proper auth (PocketBase has built-in users / OAuth) before going public.

If a user clears localStorage, their favorites are orphaned (still in the DB, just unreachable). That's the trade-off of anonymous identity. Upgrade path: when you add auth, run a one-time migration that lets users claim their device's favorites into their new account.

"Which way you voted" still stays in localStorage in both modes — the *count* is server-side, but whether you specifically voted up/down is just per-browser UI state (so the button shows the right active style).

## Going public — Vercel frontend + Tailscale Funnel backend

The split-host architecture:

```
┌────────────────────────────┐         HTTPS         ┌──────────────────────────────┐
│  coolspots.vercel.app      │  ───────────────────▶ │  Tailscale Funnel            │
│  Vercel CDN, static files  │   CORS allowlist      │  coolspots.<tailnet>.ts.net  │
│                            │                       │  → coolspots-funnel pod      │
└────────────────────────────┘                       │  → coolspots service :80     │
                                                     │  → PocketBase pod + PVC      │
                                                     └──────────────────────────────┘
```

### 1. Expose the backend via Tailscale Funnel

`deploy/funnel.yaml` adds a `coolspots-funnel` StatefulSet running the `tailscale/tailscale` image in userspace mode. It joins your tailnet as a device named `coolspots`, gets a `*.ts.net` HTTPS cert automatically, and proxies traffic to the in-cluster PocketBase service.

**One-time setup:**

1. In the Tailscale admin → [Settings → OAuth clients](https://login.tailscale.com/admin/settings/oauth) (recommended) or [Auth keys](https://login.tailscale.com/admin/settings/keys), generate an auth key. Tag it `tag:k8s` if you use ACLs.
2. Create the Secret (do NOT commit it):
   ```bash
   kubectl create namespace coolspots --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n coolspots create secret generic tailscale-auth \
     --from-literal=TS_AUTHKEY='tskey-auth-XXXX...'
   ```
3. In Tailscale admin → [DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** + **HTTPS Certificates**, then [DNS → Funnel](https://login.tailscale.com/admin/funnel) and allow the `coolspots` device (or any tag you assigned it).
4. Apply the kustomization. The funnel pod will log a join URL the first time — visit it to authorize the device.
5. Verify: `https://coolspots.<your-tailnet>.ts.net/api/health` should return `{"code": 200, "message": "API is healthy.", ...}`.

### 2. Configure CORS so Vercel can call the backend

`deploy/deployment.yaml` passes `--origins=https://coolspots.vercel.app,http://localhost:8000,http://localhost:7311`. Edit that list to your actual Vercel domain (you'll know it after the first Vercel deploy) and re-apply. Without this, browsers will block the cross-origin requests.

### 3. Deploy the frontend to Vercel

1. Push the project to a GitHub repo.
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Framework preset: **Other**. Root directory: `.`. Build command: leave empty. Output directory: leave empty (Vercel serves the root as static).
4. Deploy. First deploy gives you `your-project.vercel.app`.
5. Open `index.html` in the repo and set the meta tag to your Funnel URL:
   ```html
   <meta name="api-base" content="https://coolspots.<your-tailnet>.ts.net" />
   ```
6. Commit & push — Vercel redeploys in ~30s with the prod backend URL baked in.
7. (Optional) In Vercel project settings → Domains, attach a custom domain.

### 4. After it's live — verify the flow

- Open the Vercel URL on your phone (on cellular, not WiFi — to confirm it's truly public).
- Try favoriting a spot. The heart should fill, and ~1 second later a count chip "❤️ 1" appears on the card.
- Open the same URL on a friend's phone — they should see your count.
- The admin UI is at `https://coolspots.<your-tailnet>.ts.net/_/` — set an admin password on first visit.

## Locking it down (when you're ready)

The migration sets the `spots` collection to fully public read/write so anyone in your LAN can vote and add. To tighten:

1. In the admin UI, change `createRule` and `updateRule` to require auth (e.g. `@request.auth.id != ""`).
2. Add a `users` collection (PB has built-in auth) and a sign-in screen in the frontend.
3. For rate limiting, use nginx-ingress's `limit-rps` annotation on `ingress.yaml`.

## Backups

The whole DB is a single SQLite file at `/pb/pb_data/data.db` inside the pod. A simple cronjob can `kubectl exec` and `sqlite3 .backup`, then ship the file to wherever you keep backups.
