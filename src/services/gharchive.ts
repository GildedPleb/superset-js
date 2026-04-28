import { gunzipSync } from "node:zlib";
import * as logger from "./logger";

type GhArchiveEvent = {
  type?: string;
  repo?: { name?: string };
};

export async function fetchRecentRepoNames(hours = 4): Promise<string[]> {
  const repos = new Set<string>();
  const totals: number[] = [];

  for (let i = 0; i < hours; i++) {
    const date = new Date(Date.now() - i * 3600000);
    const ymd = date.toISOString().slice(0, 10);
    const hour = `${date.getHours()}`.padStart(2, "0");
    const url = `https://data.gharchive.org/${ymd}-${hour}.json.gz`;
    let count = 0;

    const res = await fetch(url);
    if (!res.ok) {
      totals.push(0);
      logger.info(`GHArchive ${ymd}-${hour}: 0 repos`);
      continue;
    }

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
      if (event?.type === "PushEvent" && event.repo?.name) {
        if (!repos.has(event.repo.name)) {
          repos.add(event.repo.name);
          count++;
        }
      }
    }

    totals.push(count);
    logger.info(`GHArchive ${ymd}-${hour}: ${count} repos`);
  }

  return [...repos];
}
