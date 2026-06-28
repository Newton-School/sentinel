# LLMOps dashboards & alerting

Sentinel exposes LLMOps metrics at `/metrics` (Prometheus). The dashboard and
alert rules live in-repo as the source of truth.

## Files

- `grafana/sentinel-llmops-dashboard.json` — the dashboard model: cost &
  token throughput by model+operation, LLM latency p95, error rate, user
  feedback ratio, and eval pass-ratio/mean-score by suite.
- `grafana/alerts/llmops-alerts.yaml` — alert rules (error rate, latency p95,
  cost spike, negative-feedback spike, eval regression). Thresholds are
  starting points — tune against observed baselines before paging.

## Metrics behind the panels

| Series | Source |
| --- | --- |
| `sentinel_llm_{calls,input_tokens,output_tokens,cost_usd}_total{provider,model,operation[,status]}` | PR #1 (`recordLlmCall`) |
| `sentinel_llm_latency_ms` (histogram) | PR #1 |
| `sentinel_feedback_total{sentiment}` | PR #4 |
| `sentinel_eval_pass_ratio` / `sentinel_eval_mean_score{suite}` | PR #5 gauges, read from `eval_runs` at scrape time |

## Provisioning (repo → Grafana)

```bash
npm run grafana:validate    # parse + validate the dashboard, list its metrics
npm run grafana:provision   # the above, then POST to Grafana (needs creds)
```

`grafana:provision` is a no-op preview unless `--apply` is passed **and**
`GRAFANA_URL` + `GRAFANA_TOKEN` are set — it never touches a live Grafana by
default. A CI test (`tests/grafanaDashboard.test.ts`) asserts every panel/alert
query references a metric the code actually emits, so the committed JSON can't
drift away from reality.
