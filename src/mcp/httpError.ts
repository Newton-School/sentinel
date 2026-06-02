/**
 * Side-effect-free helper for building REDACTED errors from failed upstream
 * HTTP responses.
 *
 * The MCP servers (Metabase, Slack, Google Meet) surface thrown errors back
 * into logs and the Slack-facing tool output. Embedding the raw upstream
 * response body (`await res.text()`) leaks data / identifiers / credentials
 * into those channels. This helper keeps the HTTP status (and statusText) for
 * debuggability but never reads or includes the response body.
 */
export function redactedHttpError(prefix: string, res: Response): Error {
  const statusText = res.statusText?.trim();
  const detail = statusText ? `${res.status} ${statusText}` : `${res.status}`;
  return new Error(`${prefix}: ${detail}`);
}
