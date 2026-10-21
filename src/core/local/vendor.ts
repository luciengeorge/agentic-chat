/** One service as `docker compose config --format json` (or compose.yaml itself) describes it. */
export interface ComposeService {
  image: string;
  /** A service with profiles starts only when one of them is asked for; one without starts by default. */
  profiles?: string[];
}

export interface ComposeConfig {
  services: Record<string, ComposeService>;
}

/**
 * The images an offline machine needs, each once: those of the services that start by default and of the `airgap`
 * profile, or of every profile with `all`. Two services on one image are one image to save.
 */
export function composeImages(config: ComposeConfig, all: boolean): string[] {
  return [
    ...new Set(
      Object.values(config.services)
        .filter((service) => all || !service.profiles || service.profiles.includes("airgap"))
        .map((service) => service.image),
    ),
  ];
}

/** A part of the bundle: where it goes, where it comes from, and its size (null when it isn't on this machine). */
export interface BundlePart {
  part: string;
  source: string;
  bytes: number | null;
  note?: string;
}

/** What the parts add up to; a missing part counts as nothing, and is listed as missing. */
export function bundleTotal(parts: readonly BundlePart[]): number {
  return parts.reduce((sum, part) => sum + (part.bytes ?? 0), 0);
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
