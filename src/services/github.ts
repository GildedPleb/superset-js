export type GithubFetchResult<T> = {
  status: number;
  etag: string | null;
  data: T | null;
  was304: boolean;
};

export async function githubFetch<T>(
  url: string,
  token: string,
): Promise<GithubFetchResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    "User-Agent": "linter-config-collector",
    Accept: "application/vnd.github.v3+json",
  };

  const res = await fetch(url, { headers });
  const was304 = res.status === 304;

  return {
    status: res.status,
    etag: res.headers.get("etag"),
    data: res.ok && !was304 ? ((await res.json()) as T) : null,
    was304,
  };
}
