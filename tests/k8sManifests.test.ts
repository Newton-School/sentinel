import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard test for the Kubernetes manifests packaged by buildsp.yml
 * (artifacts include `k8s/**` + imageDetail.json).
 *
 * A YAML parser (`yaml` / `js-yaml`) is not currently a dependency, so this
 * test attempts to load one dynamically and parses the manifests into objects
 * when available; otherwise it falls back to string/regex assertions over the
 * raw file contents. Either path must enforce the same invariants.
 */

const k8sDir = join(process.cwd(), "k8s");

function read(name: string): string {
  return readFileSync(join(k8sDir, name), "utf8");
}

// Attempt to load a YAML parser. parseAll returns every document in a
// multi-doc file (`---` separated) as an array of objects.
let parseAll: ((src: string) => unknown[]) | null = null;

beforeAll(async () => {
  // Try the `yaml` package first, then `js-yaml`.
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

describe("k8s manifests exist", () => {
  it("includes all expected manifest files", () => {
    for (const f of [
      "deployment.yaml",
      "service.yaml",
      "pvc.yaml",
      "configmap.yaml",
      "secret.example.yaml",
      "README.md",
    ]) {
      expect(existsSync(join(k8sDir, f)), `k8s/${f} should exist`).toBe(true);
    }
  });
});

describe("k8s/deployment.yaml", () => {
  it("is a single-replica Deployment with a Recreate strategy", () => {
    const raw = read("deployment.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Deployment");
      expect(doc, "a Deployment document").toBeTruthy();
      expect(doc.spec.replicas).toBe(1);
      expect(doc.spec.strategy.type).toBe("Recreate");
    } else {
      expect(raw).toMatch(/kind:\s*Deployment/);
      expect(raw).toMatch(/replicas:\s*1\b/);
      expect(raw).toMatch(/strategy:[\s\S]*type:\s*Recreate/);
    }
  });

  it("exposes containerPort 8080", () => {
    const raw = read("deployment.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Deployment");
      const container = doc.spec.template.spec.containers[0];
      const ports = container.ports.map((p: any) => p.containerPort);
      expect(ports).toContain(8080);
    } else {
      expect(raw).toMatch(/containerPort:\s*8080\b/);
    }
  });

  it("has a liveness probe on /health and a readiness probe on /ready", () => {
    const raw = read("deployment.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Deployment");
      const container = doc.spec.template.spec.containers[0];
      expect(container.livenessProbe.httpGet.path).toBe("/health");
      expect(container.readinessProbe.httpGet.path).toBe("/ready");
    } else {
      expect(raw).toMatch(/livenessProbe:[\s\S]*path:\s*\/health/);
      expect(raw).toMatch(/readinessProbe:[\s\S]*path:\s*\/ready/);
    }
  });

  it("mounts /app/data from a volume backed by a PVC", () => {
    const raw = read("deployment.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Deployment");
      const podSpec = doc.spec.template.spec;
      const container = podSpec.containers[0];
      const mount = container.volumeMounts.find((m: any) => m.mountPath === "/app/data");
      expect(mount, "a volumeMount at /app/data").toBeTruthy();
      const vol = podSpec.volumes.find((v: any) => v.name === mount.name);
      expect(vol, "a matching volume for the /app/data mount").toBeTruthy();
      expect(vol.persistentVolumeClaim?.claimName, "volume references a PVC").toBeTruthy();
    } else {
      expect(raw).toMatch(/mountPath:\s*\/app\/data/);
      expect(raw).toMatch(/persistentVolumeClaim:/);
      expect(raw).toMatch(/claimName:/);
    }
  });

  it("pulls env from the sentinel-secrets Secret via envFrom", () => {
    const raw = read("deployment.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Deployment");
      const container = doc.spec.template.spec.containers[0];
      const fromSecret = (container.envFrom ?? []).some(
        (e: any) => e.secretRef?.name === "sentinel-secrets",
      );
      expect(fromSecret, "envFrom references sentinel-secrets").toBe(true);
    } else {
      expect(raw).toMatch(/envFrom:/);
      expect(raw).toMatch(/secretRef:[\s\S]*name:\s*sentinel-secrets/);
    }
  });
});

describe("k8s/service.yaml", () => {
  it("is a Service mapping port 8080 to targetPort 8080", () => {
    const raw = read("service.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Service");
      expect(doc, "a Service document").toBeTruthy();
      const portEntry = doc.spec.ports.find((p: any) => p.port === 8080);
      expect(portEntry, "a port 8080 entry").toBeTruthy();
      expect(portEntry.targetPort).toBe(8080);
    } else {
      expect(raw).toMatch(/kind:\s*Service/);
      expect(raw).toMatch(/port:\s*8080\b/);
      expect(raw).toMatch(/targetPort:\s*8080\b/);
    }
  });
});

describe("k8s/pvc.yaml", () => {
  it("is a ReadWriteOnce PersistentVolumeClaim", () => {
    const raw = read("pvc.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "PersistentVolumeClaim");
      expect(doc, "a PersistentVolumeClaim document").toBeTruthy();
      expect(doc.spec.accessModes).toContain("ReadWriteOnce");
    } else {
      expect(raw).toMatch(/kind:\s*PersistentVolumeClaim/);
      expect(raw).toMatch(/ReadWriteOnce/);
    }
  });
});

describe("k8s/secret.example.yaml", () => {
  it("is a Secret template containing only placeholder values (no real creds)", () => {
    const raw = read("secret.example.yaml");
    if (parseAll) {
      const doc: any = parseAll(raw).find((d: any) => d?.kind === "Secret");
      expect(doc, "a Secret document").toBeTruthy();
      const values = Object.values(doc.stringData ?? {}) as string[];
      expect(values.length, "stringData has at least one key").toBeGreaterThan(0);
      for (const v of values) {
        expect(
          /REPLACE_ME/.test(String(v)),
          `every stringData value must be a REPLACE_ME placeholder, got: ${v}`,
        ).toBe(true);
      }
    } else {
      expect(raw).toMatch(/kind:\s*Secret/);
      expect(raw).toMatch(/stringData:/);
      // Every value after a `key:` under stringData must be a placeholder.
      const lines = raw.split("\n");
      const inStringData = (() => {
        const idx = lines.findIndex((l) => /^\s*stringData:/.test(l));
        return idx === -1 ? [] : lines.slice(idx + 1);
      })();
      const valueLines = inStringData.filter((l) => /^\s+\S+:\s*\S/.test(l));
      expect(valueLines.length, "stringData has at least one key/value").toBeGreaterThan(0);
      for (const l of valueLines) {
        const value = l.slice(l.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
        expect(
          /REPLACE_ME/.test(value),
          `every stringData value must be a REPLACE_ME placeholder, got: ${l.trim()}`,
        ).toBe(true);
      }
    }
  });
});
