import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard test for the Kubernetes manifests (kustomize base + staging overlay)
 * packaged by buildspec.yml (artifacts include `k8s/**`).
 *
 * A YAML parser is loaded dynamically when available; otherwise we fall back to
 * string/regex assertions over the raw file contents. Both paths enforce the
 * same invariants.
 */

const k8sRoot = join(process.cwd(), "k8s");
const baseDir = join(k8sRoot, "base");
const stagingDir = join(k8sRoot, "overlays", "staging");

function readBase(name: string): string {
  return readFileSync(join(baseDir, name), "utf8");
}

let parseAll: ((src: string) => unknown[]) | null = null;

beforeAll(async () => {
  try {
    const mod: any = await import("yaml");
    parseAll = (src: string) => mod.parseAllDocuments(src).map((d: any) => d.toJSON());
  } catch {
    try {
      const mod: any = await import("js-yaml");
      const loadAll = mod.loadAll ?? mod.default?.loadAll;
      parseAll = (src: string) => {
        const docs: unknown[] = [];
        loadAll(src, (d: unknown) => docs.push(d));
        return docs;
      };
    } catch {
      parseAll = null;
    }
  }
});

function deploymentDoc(): any {
  const raw = readBase("deployment.yaml");
  if (!parseAll) return null;
  return parseAll(raw).find((d: any) => d?.kind === "Deployment");
}

describe("k8s layout (kustomize base + overlay)", () => {
  it("has all base manifests + the kustomization files + README", () => {
    for (const f of [
      "deployment.yaml",
      "service.yaml",
      "pvc.yaml",
      "configmap.yaml",
      "secret.example.yaml",
      "serviceaccount.yaml",
      "servicemonitor.yaml",
      "kustomization.yaml",
    ]) {
      expect(existsSync(join(baseDir, f)), `k8s/base/${f} should exist`).toBe(true);
    }
    expect(existsSync(join(stagingDir, "kustomization.yaml")), "staging overlay").toBe(true);
    expect(existsSync(join(k8sRoot, "README.md")), "k8s/README.md").toBe(true);
  });

  it("base kustomization lists the resources but NOT the secret template", () => {
    const raw = readBase("kustomization.yaml");
    expect(raw).toMatch(/deployment\.yaml/);
    expect(raw).toMatch(/service\.yaml/);
    expect(raw).toMatch(/configmap\.yaml/);
    expect(raw).toMatch(/pvc\.yaml/);
    expect(raw).not.toMatch(/^\s*-\s*secret\.example\.yaml/m);
  });

  it("staging overlay sets the namespace, references base, and rewrites the image", () => {
    const raw = readFileSync(join(stagingDir, "kustomization.yaml"), "utf8");
    expect(raw).toMatch(/namespace:\s*sentinel-staging/);
    expect(raw).toMatch(/\.\.\/\.\.\/base/);
    expect(raw).toMatch(/images:/);
    expect(raw).toMatch(/name:\s*sentinel\b/);
  });
});

describe("k8s/base/deployment.yaml", () => {
  it("is a single-replica Deployment with a Recreate strategy", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const doc = deploymentDoc();
      expect(doc).toBeTruthy();
      expect(doc.spec.replicas).toBe(1);
      expect(doc.spec.strategy.type).toBe("Recreate");
    } else {
      expect(raw).toMatch(/replicas:\s*1\b/);
      expect(raw).toMatch(/strategy:[\s\S]*type:\s*Recreate/);
    }
  });

  it("exposes containerPort 8930 and has /health + /ready + startupProbe", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const c = deploymentDoc().spec.template.spec.containers[0];
      expect(c.ports.map((p: any) => p.containerPort)).toContain(8930);
      expect(c.livenessProbe.httpGet.path).toBe("/health");
      expect(c.readinessProbe.httpGet.path).toBe("/ready");
      expect(c.startupProbe.httpGet.path).toBe("/ready");
    } else {
      expect(raw).toMatch(/containerPort:\s*8930\b/);
      expect(raw).toMatch(/livenessProbe:[\s\S]*path:\s*\/health/);
      expect(raw).toMatch(/startupProbe:[\s\S]*path:\s*\/ready/);
    }
  });

  it("sets fsGroup 1000 + runAsNonRoot so the PVC is writable by the non-root user", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const sc = deploymentDoc().spec.template.spec.securityContext;
      expect(sc.fsGroup).toBe(1000);
      expect(sc.runAsNonRoot).toBe(true);
      expect(sc.runAsUser).toBe(1000);
    } else {
      expect(raw).toMatch(/fsGroup:\s*1000/);
      expect(raw).toMatch(/runAsNonRoot:\s*true/);
    }
  });

  it("sets an explicit terminationGracePeriodSeconds + serviceAccountName", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const podSpec = deploymentDoc().spec.template.spec;
      expect(podSpec.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(35);
      expect(podSpec.serviceAccountName).toBe("sentinel");
    } else {
      expect(raw).toMatch(/terminationGracePeriodSeconds:\s*\d+/);
      expect(raw).toMatch(/serviceAccountName:\s*sentinel/);
    }
  });

  it("mounts /app/data (PVC) and has no Claude-CLI creds wiring", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const podSpec = deploymentDoc().spec.template.spec;
      const c = podSpec.containers[0];
      const dataMount = c.volumeMounts.find((m: any) => m.mountPath === "/app/data");
      expect(dataMount).toBeTruthy();
      const vol = podSpec.volumes.find((v: any) => v.name === dataMount.name);
      expect(vol.persistentVolumeClaim?.claimName).toBeTruthy();
      // The Claude CLI is gone — no ~/.claude mount, no seed init container.
      expect(c.volumeMounts.some((m: any) => m.mountPath === "/home/pwuser/.claude")).toBe(false);
      expect(podSpec.initContainers ?? []).toHaveLength(0);
    } else {
      expect(raw).toMatch(/mountPath:\s*\/app\/data/);
      expect(raw).toMatch(/claimName:/);
      expect(raw).not.toMatch(/\.claude/);
      expect(raw).not.toMatch(/claude-cli-creds/);
    }
  });

  it("pulls env from the sentinel-secrets Secret + sentinel-config ConfigMap", () => {
    const raw = readBase("deployment.yaml");
    if (parseAll) {
      const c = deploymentDoc().spec.template.spec.containers[0];
      const refs = (c.envFrom ?? []).flatMap((e: any) => [e.secretRef?.name, e.configMapRef?.name]);
      expect(refs).toContain("sentinel-secrets");
      expect(refs).toContain("sentinel-config");
    } else {
      expect(raw).toMatch(/secretRef:[\s\S]*name:\s*sentinel-secrets/);
      expect(raw).toMatch(/configMapRef:[\s\S]*name:\s*sentinel-config/);
    }
  });
});

describe("k8s/base/service.yaml", () => {
  it("maps port 8930 → targetPort 8930 with a named http port", () => {
    const raw = readBase("service.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Service");
      const portEntry = doc.spec.ports.find((p: any) => p.port === 8930);
      expect(portEntry.targetPort).toBe(8930);
      expect(portEntry.name).toBe("http");
    } else {
      expect(raw).toMatch(/port:\s*8930\b/);
      expect(raw).toMatch(/targetPort:\s*8930\b/);
    }
  });
});

describe("k8s/base/pvc.yaml", () => {
  it("is a ReadWriteOnce PersistentVolumeClaim", () => {
    const raw = readBase("pvc.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "PersistentVolumeClaim");
      expect(doc.spec.accessModes).toContain("ReadWriteOnce");
    } else {
      expect(raw).toMatch(/ReadWriteOnce/);
    }
  });
});

describe("k8s/base/secret.example.yaml", () => {
  it("is a Secret template with only REPLACE_ME placeholders (no real creds)", () => {
    const raw = readBase("secret.example.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Secret");
      const values = Object.values(doc.stringData ?? {}) as string[];
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(/REPLACE_ME/.test(String(v)), `placeholder expected, got: ${v}`).toBe(true);
      }
    } else {
      const lines = raw.split("\n");
      const idx = lines.findIndex((l) => /^\s*stringData:/.test(l));
      const valueLines = lines.slice(idx + 1).filter((l) => /^\s+\S+:\s*\S/.test(l));
      expect(valueLines.length).toBeGreaterThan(0);
      for (const l of valueLines) {
        const value = l.slice(l.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
        expect(/REPLACE_ME/.test(value), `placeholder expected, got: ${l.trim()}`).toBe(true);
      }
    }
  });
});
