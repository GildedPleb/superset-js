import { gunzipSync } from "node:zlib";
import * as logger from "./logger";

type GhArchiveEvent = {
  type?: string;
  repo?: { name?: string };
};

export type GhArchiveFetchResult = {
  ok: boolean;
  status: number;
  repoNames: string[];
};

export async function fetchRepoNamesForHour(
  targetHour: Date | string,
): Promise<GhArchiveFetchResult> {
  const date = typeof targetHour === "string" ? new Date(targetHour) : targetHour;
  const ymd = date.toISOString().slice(0, 10);
  const hour = `${date.getUTCHours()}`.padStart(2, "0");
  const url = `https://data.gharchive.org/${ymd}-${hour}.json.gz`;

  const res = await fetch(url);
  if (!res.ok) {
    logger.warn(
      `GHArchive ${ymd}-${hour}: ${res.status} ${res.statusText} (${url})`,
    );
    return { ok: false, status: res.status, repoNames: [] };
  }

  const repos = new Set<string>();
  let count = 0;
  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf-8");

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: GhArchiveEvent | undefined;
    try {
      event = JSON.parse(line) as GhArchiveEvent;
    } catch {
      continue;
    }
    if (event?.type === "PushEvent" && event.repo?.name) {
      if (!repos.has(event.repo.name)) {
        repos.add(event.repo.name);
        count++;
      }
    }
  }

  logger.info(`GHArchive ${ymd}-${hour}: ${count} repos`);
  return { ok: true, status: res.status, repoNames: [...repos] };
}
