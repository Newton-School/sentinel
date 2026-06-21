# Kubernetes manifests for Sentinel (kustomize)

Layout:

```
k8s/
  base/                     # environment-agnostic resources (+ kustomization.yaml)
    deployment.yaml service.yaml configmap.yaml pvc.yaml
    serviceaccount.yaml servicemonitor.yaml
    paradedb-statefulset.yaml paradedb-service.yaml   # the datastore
    paradedb-backup-cronjob.yaml                      # nightly pg_dump -> S3
    secret.example.yaml     # TEMPLATE only — not part of the kustomization
  overlays/
    staging/kustomization.yaml   # namespace + image for staging
```

Render / apply:

```sh
kubectl kustomize k8s/overlays/staging          # preview
kubectl apply -k  k8s/overlays/staging          # apply (or point ArgoCD/flux here)
```

The build packages `imageDetail.json` + `k8s/**` (`buildspec.yml`). With GitOps,
the deployed image **tag** is set by the overlay's `images:` block — point your
ArgoCD `Application` (or flux `Kustomization`) at `k8s/overlays/staging` and let
image-updater/flux bump `newTag`. Set `newName` to your ECR repo URI.

## Datastore: ParadeDB (Postgres + pg_search + pgvector)
Persistence lives in **ParadeDB**, run in-cluster as a single-replica
StatefulSet with its own RWO PVC (`/var/lib/postgresql/data`). The bot connects
over `DATABASE_URL` (host = the `sentinel-paradedb` headless Service) and runs
idempotent schema migrations on boot (`src/state/db.ts` `initDb`). A
`wait-for-paradedb` init container blocks the bot until Postgres accepts
connections. `pg_search` gives true BM25 for memory recall and `pgvector` backs
semantic search; on a vanilla-Postgres image the code degrades to `ts_rank` +
`pgvector` automatically.

**Backups (the durability win over the old SQLite file):** the
`sentinel-paradedb-backup` CronJob runs `pg_dump | gzip` to
`s3://$BACKUP_BUCKET/paradedb/` nightly (IRSA on the `sentinel` SA). Restore:
```sh
aws s3 cp s3://$BACKUP_BUCKET/paradedb/<file>.sql.gz - | gunzip | psql "$DATABASE_URL"
```

## Why single-replica / Recreate / ReadWriteOnce
The bot holds **one** Slack Socket-Mode connection and a shared Meet-bot Chrome
profile + logs under `/app/data` (RWO PVC). Two pods would double-process Slack
events and corrupt the Chrome profile — so the bot Deployment is **1 replica**,
**`Recreate`**, **RWO PVC**. ParadeDB is likewise a single-replica StatefulSet
(single-writer; HA is out of scope for staging).

## Hardening baked into the base Deployment
- `securityContext.fsGroup: 1000` (+ `runAsNonRoot`/`runAsUser: 1000`) — makes
  the mounted Chrome-profile PVC writable by the non-root runtime user.
- `terminationGracePeriodSeconds: 40` — covers the 25s in-flight drain + 10s
  bounded Slack-stop (see `src/shutdown.ts`); `dumb-init` (Dockerfile) reaps
  subprocess zombies and forwards SIGTERM.
- `startupProbe` on `/ready` — gates liveness/readiness during slow boot so a
  healthy-but-slow start isn't killed.

## Secrets you must create (out-of-band / sealed-secrets) in the namespace
| Secret | From | Why |
| --- | --- | --- |
| `sentinel-secrets` | `base/secret.example.yaml` | Slack/Metabase/OpenAI/Google env + `SENTINEL_OWNER_USER_ID` + **`DATABASE_URL`**. `OPENAI_API_KEY` (or `MEMORY_EMBEDDING_API_KEY`) is required — the agent reply loop runs on it. |
| `paradedb-credentials` | `base/secret.example.yaml` (2nd doc) | Postgres user/password/db for the ParadeDB StatefulSet. The password **must match** the one in `sentinel-secrets`' `DATABASE_URL`. |
| `ecr-registry` | ECR docker-registry secret | Image pull (or remove `imagePullSecrets` and use node IAM/IRSA). |

## Meet bot (kept enabled)
The Playwright joiner needs a **Google-signed-in Chrome profile** — it can't log
in headless. One-time, seed `data/sentinel-chrome-profile` onto the PVC (e.g.
`kubectl cp` from a machine that ran `npm run meet-bot:setup`, or an init-restore
from object storage). Without it the joiner can't join meetings.

## Deploy runbook (you run these with your AWS/EKS creds)
1. **Build + push** the image to ECR (`buildspec.yml` via CodeBuild, or manual
   `docker build` + `docker push`); note the tag.
2. **Set the overlay image**: edit `overlays/staging/kustomization.yaml`
   `images[].newName` to your ECR repo URI (+ `newTag`).
3. **Create the namespace + secrets** in `sentinel-staging`:
   `sentinel-secrets` (incl. `DATABASE_URL`), `paradedb-credentials`,
   `ecr-registry` (or IRSA), and set `BACKUP_BUCKET` in the ConfigMap + an IRSA
   role on the `sentinel` SA with `s3:PutObject` to that bucket.
4. **Apply**: `kubectl apply -k k8s/overlays/staging`. ParadeDB comes up, the
   `wait-for-paradedb` init container blocks the bot until PG is ready, the bot
   migrates the schema on boot and joins Slack Socket Mode.
5. **Data**: a fresh DB starts empty; the company-brain repopulates via the
   ingest/consolidation watchers. (Optional: one-time ETL from the old
   `sentinel.db`.) Stop any local `npm run dev` — only one process may hold the
   Slack socket.

## Cluster prerequisites
- A default (or named) RWO `StorageClass` for the bot PVC (`base/pvc.yaml`) and
  the ParadeDB PVC (`paradedb-statefulset.yaml` volumeClaimTemplate).
- An **S3 bucket** (`BACKUP_BUCKET`) + **IRSA** role on the `sentinel` SA with
  `s3:PutObject` for the nightly backup CronJob.
- **Egress** to: Slack, OpenAI, the Metabase host, Google APIs, and the npm
  registry (the GitHub/Notion MCP servers `npx`-install at runtime — or leave
  their tokens unset to disable them).
- **Prometheus Operator** CRD for `servicemonitor.yaml` (else drop it from
  `base/kustomization.yaml` and use a static scrape job for `:8930/metrics`).
- A **staging Slack app** (separate Socket-Mode app + tokens, `usergroups:read`
  scope, interactivity enabled, bot invited to the channels).
