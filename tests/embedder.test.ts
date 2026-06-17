import { describe, it, expect, beforeEach, vi } from "vitest";

// Intercept the LLM trace sink: telemetry recording is observable and never
// touches the DB.
const { recordLlmCallSpy } = vi.hoisted(() => ({ recordLlmCallSpy: vi.fn() }));
vi.mock("../src/llm/traceStore.js", () => ({ recordLlmCall: recordLlmCallSpy }));

import {
  floatToBlob,
  blobToFloat,
  cosine,
  embedText,
  embedTexts,
  __resetEmbeddingBudgetForTests,
} from "../src/memory/embedder.js";

const NOW = () => Date.parse("2026-06-14T00:00:00.000Z");

/** A fake OpenAI embeddings endpoint returning one vector per input, in order. */
function fakeOpenAI(vectors: number[][]) {
  const bodies: any[] = [];
  const fn = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        object: "list",
        data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe("embedder float<->blob", () => {
  it("round-trips a Float32Array losslessly", () => {
    const v = new Float32Array([0.5, -0.25, 1, 0]);
    const back = blobToFloat(floatToBlob(v));
    expect(Array.from(back)).toEqual([0.5, -0.25, 1, 0]);
  });
});

describe("embedder cosine", () => {
  it("is 1 for identical vectors, 0 for orthogonal, symmetric", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 5);
  });

  it("handles a zero vector without NaN", () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("embedText", () => {
  beforeEach(() => __resetEmbeddingBudgetForTests());

  it("returns a Float32Array from the OpenAI response", async () => {
    const { fn, bodies } = fakeOpenAI([[0.1, 0.2, 0.3]]);
    const v = await embedText("hello", { apiKey: "k", fetchImpl: fn, now: NOW });
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v!)).toHaveLength(3);
    expect(bodies[0].model).toBe("text-embedding-3-small");
    expect(bodies[0].input).toEqual(["hello"]);
  });

  it("uses the configured model override", async () => {
    const { fn, bodies } = fakeOpenAI([[1, 0]]);
    await embedText("x", { apiKey: "k", model: "text-embedding-3-large", fetchImpl: fn, now: NOW });
    expect(bodies[0].model).toBe("text-embedding-3-large");
  });

  it("returns null without an API key (logged no-op)", async () => {
    expect(await embedText("hello", { now: NOW })).toBeNull();
  });

  it("returns null on an HTTP error (never throws)", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await embedText("hello", { apiKey: "k", fetchImpl: failing, now: NOW })).toBeNull();
  });
});

describe("embedTexts (batch)", () => {
  beforeEach(() => __resetEmbeddingBudgetForTests());

  it("returns one vector per input, in order, in a single request", async () => {
    const { fn, bodies } = fakeOpenAI([[1, 0], [0, 1]]);
    const out = await embedTexts(["a", "b"], { apiKey: "k", fetchImpl: fn, now: NOW });
    expect(out).toHaveLength(2);
    expect(Array.from(out[0]!)).toEqual([1, 0]);
    expect(Array.from(out[1]!)).toEqual([0, 1]);
    expect(bodies).toHaveLength(1); // batched
  });

  it("returns an empty array for empty input without calling the API", async () => {
    const { fn, bodies } = fakeOpenAI([]);
    expect(await embedTexts([], { apiKey: "k", fetchImpl: fn, now: NOW })).toEqual([]);
    expect(bodies).toHaveLength(0);
  });
});

describe("embedder telemetry", () => {
  beforeEach(() => {
    __resetEmbeddingBudgetForTests();
    recordLlmCallSpy.mockClear();
  });

  it("records one 'embed' call per request with prompt-token cost on success", async () => {
    const { fn } = fakeOpenAI([[0.1, 0.2]]); // fakeOpenAI sets usage.prompt_tokens = 1
    await embedText("hi", { apiKey: "k", fetchImpl: fn, now: NOW });
    expect(recordLlmCallSpy).toHaveBeenCalledTimes(1);
    const arg = recordLlmCallSpy.mock.calls[0][0];
    expect(arg.provider).toBe("openai");
    expect(arg.operation).toBe("embed");
    expect(arg.model).toBe("text-embedding-3-small");
    expect(arg.inputTokens).toBe(1);
    expect(arg.outputTokens).toBe(0);
    expect(arg.status).toBe("ok");
    expect(arg.costUsd).toBeGreaterThan(0);
    expect(typeof arg.latencyMs).toBe("number");
  });

  it("records an error 'embed' call on an HTTP failure", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await embedText("hi", { apiKey: "k", fetchImpl: failing, now: NOW });
    expect(recordLlmCallSpy).toHaveBeenCalledTimes(1);
    expect(recordLlmCallSpy.mock.calls[0][0].status).toBe("error");
    expect(recordLlmCallSpy.mock.calls[0][0].errorKind).toBe("http");
  });

  it("does NOT record a call without an API key", async () => {
    await embedText("hi", { now: NOW });
    expect(recordLlmCallSpy).not.toHaveBeenCalled();
  });
});
