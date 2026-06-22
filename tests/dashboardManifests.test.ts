import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const k8s = (f: string) => readFileSync(join(process.cwd(), "k8s", "base", f), "utf8");

describe("dashboard kustomize wiring", () => {
  const kust = k8s("kustomization.yaml");
  it("registers the dashboard resources in the base", () => {
    for (const r of ["dashboard-configmap.yaml", "dashboard-deployment.yaml", "dashboard-service.yaml", "dashboard-ingress.yaml"]) {
      expect(kust, `kustomization should list ${r}`).toContain(r);
    }
  });
});

describe("dashboard Deployment", () => {
  const dep = k8s("dashboard-deployment.yaml");

  it("uses the dedicated sentinel-dashboard image", () => {
    expect(dep).toMatch(/image:\s*sentinel-dashboard/);
  });

  it("is horizontally scalable and rolling (NOT a single Recreate pod like the bot)", () => {
    expect(dep).toMatch(/replicas:\s*2/);
    expect(dep).toMatch(/RollingUpdate/);
    expect(dep).not.toMatch(/Recreate/);
  });

  it("is stateless — no PersistentVolumeClaim / volume mount", () => {
    expect(dep).not.toMatch(/[Pp]ersistentVolumeClaim/);
    expect(dep).not.toMatch(/volumeMounts/);
  });

  it("probes the dashboard's own /api/health on port 8940", () => {
    expect(dep).toMatch(/path:\s*\/api\/health/);
    expect(dep).toMatch(/containerPort:\s*8940/);
  });

  it("carries ONLY the dashboard secret, never the bot's sentinel-secrets", () => {
    expect(dep).toMatch(/sentinel-dashboard-secrets/);
    expect(dep).not.toMatch(/name:\s*sentinel-secrets/);
  });

  it("runs as non-root", () => {
    expect(dep).toMatch(/runAsNonRoot:\s*true/);
  });
});

describe("dashboard Service + Ingress", () => {
  it("service exposes port 8940", () => {
    expect(k8s("dashboard-service.yaml")).toMatch(/port:\s*8940/);
  });
  it("ingress is auth-gated (oauth2-proxy) and TLS via cert-manager", () => {
    const ing = k8s("dashboard-ingress.yaml");
    expect(ing).toMatch(/kind:\s*Ingress/);
    expect(ing).toMatch(/auth-(url|signin)/); // nginx oauth2-proxy external auth
    expect(ing).toMatch(/cert-manager\.io\/(cluster-)?issuer/);
    expect(ing).toMatch(/tls:/);
  });
});

describe("SELECT-only Postgres role", () => {
  const sql = readFileSync(join(process.cwd(), "k8s", "base", "readonly-role.sql"), "utf8");
  it("grants only SELECT (no write privileges) and covers future tables", () => {
    expect(sql).toMatch(/GRANT SELECT/i);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*ON/i);
  });
});

describe("dashboard secret template", () => {
  it("adds a dashboard secret with a read-only DB URL (separate from sentinel-secrets)", () => {
    const sec = k8s("secret.example.yaml");
    expect(sec).toMatch(/sentinel-dashboard-secrets/);
    expect(sec).toMatch(/DATABASE_URL_READONLY/);
  });
});
