// 👨‍💼 The offline machine needs the container images Compose runs, saved to files beforehand: on the day, there's
//    no registry to pull from. Images are big (ParadeDB is 1.49 GB, the observability stack 3.48 GB, docling
//    7.26 GB), so the bundle should hold exactly what the air-gapped app runs, once each.

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
  // 🐨 Go through the services. Keep a service when `all` is set, when it has no profiles (it starts by default),
  //    or when `airgap` is one of its profiles. Return their images, each once, in the order they came.
  //
  // 🐨 The classic mistake is one image per service: `airgap-db` and `airgap-probe` run the paradedb image too,
  //    and saving it three times makes a 1.49 GB part 4.47 GB.
  //
  // 💰 `Object.values(config.services)`; `[...new Set(list)]` keeps the first of each, in order.
  //
  // 🦉 Why profiles decide. A Compose profile is a label that keeps a service from starting until you ask for it
  //    (`--profile observability`). The services with none are the app's own (ParadeDB); `airgap` holds the
  //    egress check. Docling (section 03) and otel-lgtm (section 19) are profiles too: tools for other sections,
  //    10.7 GB together, that the air-gapped app never starts. `pnpm vendor --images all` takes them anyway.
  // 🦉 Why exact tags. Every image here is pinned (`paradedb/paradedb:0.26.1-pg18`, never `latest`), as the
  //    lockfile pins every package and the manifest pins the weights' commit. A bundle is only useful if the
  //    offline machine runs the same bytes you tested.
  //
  // 📜 https://docs.docker.com/compose/how-tos/profiles/
  //
  // 🚨 The tests check compose.yaml's own services (one image by default, three with all), a service with no
  //    profiles, one with several, and the bundle the dry run measured: 3.83 GB.
  throw new Error(`composeImages(${Object.keys(config.services).length} services, all: ${all}) isn't written yet`);
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
