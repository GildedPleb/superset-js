import { gunzipSync } from "node:zlib";
import { fetchWithRetry } from "../utils/http";
import { createLogger } from "./logger";

const logger = createLogger("GhArchive");

type GhArchiveEvent = {
  type?: string;
  repo?: { name?: string };
  created_at?: string;
};

// Engagement set for the engagement-gate paradigm. PushEvents are the
// population, not engagement. CreateEvent/DeleteEvent/PublicEvent are
// repo-lifecycle noise and intentionally excluded — they fire on every
// brand-new throwaway repo. Source: empirical Phase-0 analysis.
const ENGAGEMENT_EVENT_TYPES = new Set([
  "PullRequestEvent",
  "PullRequestReviewEvent",
  "PullRequestReviewCommentEvent",
  "IssuesEvent",
  "IssueCommentEvent",
  "WatchEvent",
  "ForkEvent",
  "ReleaseEvent",
  "MemberEvent",
  "CommitCommentEvent",
  "GollumEvent",
  "DiscussionEvent",
]);

export type ArchiveEntry = {
  fullName: string;
  createdAt: string; // ISO8601 from event.created_at
};

export type GhArchiveFetchResult = {
  ok: boolean;
  status: number;
  pushes: ArchiveEntry[];
  engagements: ArchiveEntry[];
};

export async function fetchEventsForHour(
  targetHour: Date | string,
  signal: AbortSignal,
): Promise<GhArchiveFetchResult> {
  const date =
    typeof targetHour === "string" ? new Date(targetHour) : targetHour;
  const ymd = date.toISOString().slice(0, 10);

  // GHArchive uses NO leading zero for hours 0-9: -0, -1, ..., -9, -10...
  const hour = date.getUTCHours().toString();

  const url = `https://data.gharchive.org/${ymd}-${hour}.json.gz`;

  let res: Response;
  try {
    res = await fetchWithRetry(url, undefined, undefined, signal);
  } catch (err) {
    if (err instanceof Error) {
      if (err.name !== "AbortError")
        logger.warn(
          `GHArchive ${ymd}-${hour}: request failed (${url}) ${err.message}`,
        );

      return { ok: false, status: 0, pushes: [], engagements: [] };
    }
    logger.warn(
      `GHArchive ${ymd}-${hour}: request failed unknown (${url}) ${String(err)}`,
    );
    return { ok: false, status: 0, pushes: [], engagements: [] };
  }
  if (!res.ok) {
    logger.warn(
      `GHArchive ${ymd}-${hour}: ${res.status} ${res.statusText} (${url})`,
    );
    return {
      ok: false,
      status: res.status,
      pushes: [],
      engagements: [],
    };
  }

  // Per-repo dedup within the same hour:
  //  - For pushes: keep the LATEST createdAt (so MAX upsert is well-defined).
  //  - For engagements: keep the EARLIEST createdAt (the first signal is
  //    the one that should fire promotion; later ones in the same hour
  //    would be no-ops anyway).
  const pushMap = new Map<string, string>();
  const engagementMap = new Map<string, string>();

  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString(
    "utf-8",
  );

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: GhArchiveEvent | undefined;
    try {
      event = JSON.parse(line) as GhArchiveEvent;
    } catch {
      continue;
    }
    const type = event?.type;
    const fullName = event?.repo?.name;
    const createdAt = event?.created_at;
    if (!type || !fullName || !createdAt) continue;

    if (type === "PushEvent") {
      const prev = pushMap.get(fullName);
      if (!prev || createdAt > prev) pushMap.set(fullName, createdAt);
    } else if (ENGAGEMENT_EVENT_TYPES.has(type)) {
      const prev = engagementMap.get(fullName);
      if (!prev || createdAt < prev) engagementMap.set(fullName, createdAt);
    }
  }

  const pushes: ArchiveEntry[] = [];
  for (const [fullName, createdAt] of pushMap) {
    pushes.push({ fullName, createdAt });
  }
  const engagements: ArchiveEntry[] = [];
  for (const [fullName, createdAt] of engagementMap) {
    engagements.push({ fullName, createdAt });
  }

  return { ok: true, status: res.status, pushes, engagements };
}
