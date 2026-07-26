export interface BuildInfo {
  timestamp: string;
  date: string;
}

let cachedBuildInfo: BuildInfo | null = null;

export async function getBuildInfo(): Promise<BuildInfo> {
  if (cachedBuildInfo) return cachedBuildInfo;

  try {
    const response = await fetch('/build-info.json');
    if (!response.ok) throw new Error('Failed to fetch build info');
    const data = (await response.json()) as BuildInfo;
    cachedBuildInfo = data;
    return data;
  } catch (err) {
    console.warn('Could not load build info:', err);
    return {
      timestamp: new Date().toISOString(),
      date: 'Unknown',
    };
  }
}
