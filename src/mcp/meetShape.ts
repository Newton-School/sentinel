/**
 * Pure, side-effect-free shaping helpers for the Google Meet MCP server.
 *
 * No `process.env` reads, no fetch, no server bootstrap — `meet.ts` performs the
 * authenticated Meet REST API calls and passes the parsed response bodies
 * through these helpers. Participant-name resolution lives in `participantName.ts`.
 */

/** Pull the trailing id off a Meet resource name (e.g. ".../participants/123" → "123"). */
export function resourceId(name: string | undefined | null): string | undefined {
  return name?.split("/").pop();
}

export interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
}

export interface MappedConference {
  id: string | undefined;
  resourceName: string;
  startTime: string | undefined;
  endTime: string | undefined;
  spaceName: string | undefined;
}

/** Map `conferenceRecords` list entries to the tool's summary shape. */
export function mapConferences(
  records: ConferenceRecord[]
): MappedConference[] {
  return records.map((c) => ({
    id: resourceId(c.name),
    resourceName: c.name,
    startTime: c.startTime,
    endTime: c.endTime,
    spaceName: c.space,
  }));
}

export interface TranscriptRecord {
  name: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

export interface MappedTranscript {
  id: string | undefined;
  resourceName: string;
  state: string | undefined;
  startTime: string | undefined;
  endTime: string | undefined;
  driveDocumentId: string | undefined;
  driveDocumentUrl: string | undefined;
}

/** Map `transcripts` list entries, flattening docsDestination. */
export function mapTranscripts(
  records: TranscriptRecord[]
): MappedTranscript[] {
  return records.map((t) => ({
    id: resourceId(t.name),
    resourceName: t.name,
    state: t.state,
    startTime: t.startTime,
    endTime: t.endTime,
    driveDocumentId: t.docsDestination?.document,
    driveDocumentUrl: t.docsDestination?.exportUri,
  }));
}

export interface RawTranscriptEntry {
  participant?: string;
  text?: string;
  languageCode?: string;
  startTime?: string;
  endTime?: string;
}

export interface ShapedTranscriptEntry {
  speaker: string | undefined;
  participant: string | undefined;
  speakerId: string | undefined;
  text: string | undefined;
  startTime: string | undefined;
  endTime: string | undefined;
  language: string | undefined;
}

/**
 * Shape a single transcript entry into the tool's output row.
 *
 * `speaker` is the resolved human display name; resolution is async and
 * I/O-bound in the server, so it's injected here as an already-resolved string
 * (or undefined when the entry has no participant). The raw `participant`
 * resource name is retained under both `participant` and `speakerId`.
 */
export function shapeTranscriptEntry(
  entry: RawTranscriptEntry,
  resolvedSpeaker: string | undefined
): ShapedTranscriptEntry {
  return {
    speaker: entry.participant ? resolvedSpeaker : undefined,
    participant: entry.participant,
    speakerId: entry.participant,
    text: entry.text,
    startTime: entry.startTime,
    endTime: entry.endTime,
    language: entry.languageCode,
  };
}
