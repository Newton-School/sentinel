# Kubernetes manifests for Sentinel

These manifests are packaged as a CodeBuild artifact (`buildspec.yml` ships
`imageDetail.json` + `k8s/**/*`) and applied to the cluster by the deploy stage.

## What's here

| File                  | Object                                | Purpose                                                       |
| --------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `configmap.yaml`      | ConfigMap `sentinel-config`           | Non-secret tunables (`LOG_LEVEL`, `SQLITE_DB_PATH`, `HEALTH_CHECK_PORT`). |
| `secret.example.yaml` | Secret `sentinel-secrets` (template)  | Placeholder secret env. **Do not commit real values.**       |
| `pvc.yaml`            | PersistentVolumeClaim `sentinel-data` | ReadWriteOnce 5Gi volume for `/app/data`.                    |
| `deployment.yaml`     | Deployment `sentinel`                  | Single replica, `Recreate` strategy, probes, env, volume.    |
| `service.yaml`        | Service `sentinel`                     | ClusterIP, port 8080 → targetPort 8080.                      |

## Why single-replica / Recreate / ReadWriteOnce

Sentinel keeps all state under `/app/data`: the SQLite DB (`sentinel.db`, a
single-writer WAL database), the persistent Chrome profile used by the Meet
bot, and meet-bot logs. None of that is safe to share between pods, so the
Deployment runs **one replica** with a **`Recreate`** strategy (the old pod is
torn down before the new one starts) backed by a **ReadWriteOnce** PVC. This
guarantees the volume is never mounted by two pods at once.

## Apply order

Dependencies (ConfigMap/Secret/PVC) must exist before the Deployment that
references them:

```sh
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml      # your real copy of secret.example.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

The secret is applied out-of-band from a private copy with real values — see
the header of `secret.example.yaml`.

## Image substitution at deploy time

`deployment.yaml` ships with `image: PLACEHOLDER_IMAGE_URI`. The build writes
the sha-pinned ECR image URI to `imageDetail.json`
(`{"ImageURI":"<acct>.dkr.ecr.<region>.amazonaws.com/sentinel:<sha>"}`). The
deploy step pins it before applying, either by patching a running Deployment:

```sh
kubectl set image deployment/sentinel \
  sentinel="$(jq -r .ImageURI imageDetail.json)"
```

or by substituting the placeholder in the manifest before `kubectl apply`:

```sh
sed "s#PLACEHOLDER_IMAGE_URI#$(jq -r .ImageURI imageDetail.json)#" \
  k8s/deployment.yaml | kubectl apply -f -
```
