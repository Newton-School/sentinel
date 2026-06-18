# Kubernetes manifests for Sentinel (kustomize)

Layout:

```
k8s/
  base/                     # environment-agnostic resources (+ kustomization.yaml)
    deployment.yaml service.yaml configmap.yaml pvc.yaml
    serviceaccount.yaml servicemonitor.yaml
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

## Why single-replica / Recreate / ReadWriteOnce
All state lives under `/app/data`: the SQLite DB (single-writer WAL), the Meet
bot's Chrome profile, and meet-bot logs. The bot also holds **one** Slack
Socket-Mode connection. Sharing any of that across pods would double-process
events and corrupt state — so it's **1 replica**, **`Recreate`**, **RWO PVC**.

## Hardening baked into the base Deployment
- `securityContext.fsGroup: 1000` (+ `runAsNonRoot`/`runAsUser: 1000`) — without
  `fsGroup` the mounted PVC is root-owned and SQLite can't open the DB.
- `terminationGracePeriodSeconds: 40` — covers the 25s in-flight drain + 10s
  bounded Slack-stop (see `src/shutdown.ts`); `dumb-init` (Dockerfile) reaps
  subprocess zombies and forwards SIGTERM.
- `startupProbe` on `/ready` — gates liveness/readiness during slow boot/CLI
  warmup so a healthy-but-slow start isn't killed.

## Secrets you must create (out-of-band / sealed-secrets) in the namespace
| Secret | From | Why |
| --- | --- | --- |
| `sentinel-secrets` | `base/secret.example.yaml` | Slack/Metabase/OpenAI/Google env + `SENTINEL_OWNER_USER_ID`. |
| `claude-cli-creds` | a logged-in machine's `~/.claude` | The `claude` CLI authenticates via its **own login**, NOT an env var. The init container seeds it into a writable `~/.claude`. |
| `ecr-registry` | ECR docker-registry secret | Image pull (or remove `imagePullSecrets` and use node IAM/IRSA). |

Create the Claude creds Secret, e.g.:
```sh
kubectl -n sentinel-staging create secret generic claude-cli-creds \
  --from-file=$HOME/.claude/        # the exact files vary — verify on a logged-in box
```
> ⚠️ Verify the precise `~/.claude` contents/filenames the installed CLI uses,
> and plan rotation (subscription logins expire). This is the #1 deploy blocker.

## Meet bot (kept enabled)
The Playwright joiner needs a **Google-signed-in Chrome profile** — it can't log
in headless. One-time, seed `data/sentinel-chrome-profile` onto the PVC (e.g.
`kubectl cp` from a machine that ran `npm run meet-bot:setup`, or an init-restore
from object storage). Without it the joiner can't join meetings.

## Cluster prerequisites
- A default (or named) RWO `StorageClass` for the PVC (`base/pvc.yaml`).
- **Egress** to: Slack, Anthropic (the CLI), OpenAI, the Metabase host, Google
  APIs, and the npm registry (the GitHub/Notion MCP servers `npx`-install at
  runtime — or leave their tokens unset to disable them).
- **Prometheus Operator** CRD for `servicemonitor.yaml` (else drop it from
  `base/kustomization.yaml` and use a static scrape job for `:8930/metrics`).
- A **staging Slack app** (separate Socket-Mode app + tokens, `usergroups:read`
  scope, interactivity enabled, bot invited to the channels).
