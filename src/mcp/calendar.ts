#!/usr/bin/env node

/**
 * Google Calendar MCP Server — exposes calendar events as MCP tools.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Uses OAuth2 with a refresh token for the Sentinel Google service account.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { z } from "zod";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const calendar = google.calendar({ version: "v3", auth });

const server = new McpServer({
  name: "google-calendar",
  version: "0.1.0",
});

// Tool: List events in a date range
server.tool(
  "calendar_list_events",
  "List calendar events in a date range. Defaults to this week. Returns event title, time, attendees, and meeting links.",
  {
    start_date: z.string().optional().describe("Start date in ISO format (e.g., '2026-04-07'). Defaults to start of current week (Monday)."),
    end_date: z.string().optional().describe("End date in ISO format (e.g., '2026-04-11'). Defaults to end of current week (Friday)."),
    max_results: z.number().default(25).describe("Maximum events to return (default: 25, max: 50)"),
    calendar_id: z.string().default("primary").describe("Calendar ID (default: 'primary')"),
  },
  async ({ start_date, end_date, max_results, calendar_id }) => {
    const now = new Date();

    // Default to this week (Monday to Friday)
    let timeMin: string;
    let timeMax: string;

    if (start_date) {
      timeMin = new Date(start_date).toISOString();
    } else {
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      timeMin = monday.toISOString();
    }

    if (end_date) {
      const end = new Date(end_date);
      end.setHours(23, 59, 59, 999);
      timeMax = end.toISOString();
    } else {
      const friday = new Date(now);
      friday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 4);
      friday.setHours(23, 59, 59, 999);
      timeMax = friday.toISOString();
    }

    const res = await calendar.events.list({
      calendarId: calendar_id,
      timeMin,
      timeMax,
      maxResults: Math.min(max_results, 50),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items ?? []).map((event) => ({
      id: event.id,
      summary: event.summary ?? "(no title)",
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      description: event.description?.slice(0, 300),
      location: event.location,
      meetLink: event.hangoutLink,
      attendees: (event.attendees ?? []).map((a) => ({
        email: a.email,
        displayName: a.displayName,
        responseStatus: a.responseStatus,
      })),
      organizer: event.organizer?.email,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ timeRange: { from: timeMin, to: timeMax }, eventCount: events.length, events }, null, 2),
        },
      ],
    };
  }
);

// Tool: Get detailed info about a specific event
server.tool(
  "calendar_get_event",
  "Get detailed information about a specific calendar event including attendees, description, and meeting link.",
  {
    event_id: z.string().describe("The Google Calendar event ID"),
    calendar_id: z.string().default("primary").describe("Calendar ID (default: 'primary')"),
  },
  async ({ event_id, calendar_id }) => {
    const event = await calendar.events.get({
      calendarId: calendar_id,
      eventId: event_id,
    });

    const result = {
      id: event.data.id,
      summary: event.data.summary,
      description: event.data.description,
      start: event.data.start?.dateTime ?? event.data.start?.date,
      end: event.data.end?.dateTime ?? event.data.end?.date,
      location: event.data.location,
      meetLink: event.data.hangoutLink,
      organizer: event.data.organizer,
      attendees: (event.data.attendees ?? []).map((a) => ({
        email: a.email,
        displayName: a.displayName,
        responseStatus: a.responseStatus,
      })),
      recurrence: event.data.recurrence,
      status: event.data.status,
      created: event.data.created,
      updated: event.data.updated,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Tool: Search events by keyword
server.tool(
  "calendar_search",
  "Search calendar events by keyword. Searches across event titles and descriptions.",
  {
    query: z.string().describe("Keyword to search for in event titles and descriptions"),
    days_back: z.number().default(30).describe("Number of days to look back (default: 30)"),
    days_forward: z.number().default(7).describe("Number of days to look forward (default: 7)"),
    max_results: z.number().default(20).describe("Maximum results (default: 20, max: 50)"),
    calendar_id: z.string().default("primary").describe("Calendar ID (default: 'primary')"),
  },
  async ({ query, days_back, days_forward, max_results, calendar_id }) => {
    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setDate(now.getDate() - days_back);
    const timeMax = new Date(now);
    timeMax.setDate(now.getDate() + days_forward);

    const res = await calendar.events.list({
      calendarId: calendar_id,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      q: query,
      maxResults: Math.min(max_results, 50),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items ?? []).map((event) => ({
      id: event.id,
      summary: event.summary ?? "(no title)",
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      meetLink: event.hangoutLink,
      attendeeCount: event.attendees?.length ?? 0,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ query, eventCount: events.length, events }, null, 2),
        },
      ],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Google Calendar MCP server fatal error:", err);
  process.exit(1);
});
