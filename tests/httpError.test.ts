import { describe, it, expect } from "vitest";
import { redactedHttpError } from "../src/mcp/httpError.js";

/**
 * Minimal Response-like stub: only the fields redactedHttpError reads.
 */
function fakeResponse(status: number, statusText: string): Response {
  return { status, statusText } as unknown as Response;
}

describe("redactedHttpError", () => {
  it("returns an Error with prefix + status + statusText", () => {
    const err = redactedHttpError(
      "Metabase API error",
      fakeResponse(500, "Internal Server Error")
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Metabase API error: 500 Internal Server Error");
  });

  it("does not leak a response body (only status/statusText)", () => {
    // The helper never reads res.text(); a body must never appear in the message.
    const err = redactedHttpError("Slack API error", fakeResponse(403, "Forbidden"));
    expect(err.message).toBe("Slack API error: 403 Forbidden");
    expect(err.message).not.toMatch(/body|token|secret|xoxp|@/i);
  });

  it("includes only the status when statusText is empty", () => {
    const err = redactedHttpError("Google Meet API error", fakeResponse(401, ""));
    // No trailing whitespace from an empty statusText.
    expect(err.message).toBe("Google Meet API error: 401");
  });

  it("trims a whitespace-only statusText to just the status", () => {
    const err = redactedHttpError("Token refresh failed", fakeResponse(400, "   "));
    expect(err.message).toBe("Token refresh failed: 400");
  });
});
