/** Loading the corpus build (`manifest.json` and its blobs) into sites, and resetting them. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { WorldError, loadWorld } from "@/fixtures/world";

import { Directory } from "./directory";
import { Item, Site, nameKey, sha256 } from "./site";

export const TOKEN_PREFIX = "dev-workspace-";

export class CorpusError extends Error {
  override name = "CorpusError";
}

export const awareDatetime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

export const SharingSchema = z.object({
  inherit: z.boolean().default(true),
  grants: z
    .array(
      z.object({
        principal_type: z.enum(["user", "group"]),
        principal_id: z.string(),
        principal_name: z.string(),
        role: z.enum(["read", "write"]),
      }),
    )
    .default([]),
});

const ManifestItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  parent_id: z.string().nullable(),
  kind: z.enum(["folder", "file"]),
  created: awareDatetime,
  modified: awareDatetime,
  created_by: z.string().nullable(),
  modified_by: z.string().nullable(),
  file: z.object({ mime_type: z.string(), size: z.int(), sha256: z.string(), blob: z.string() }).nullish(),
  sharing: SharingSchema,
});

const ManifestSiteSchema = z.object({
  items: z.array(ManifestItemSchema),
  users: z.record(z.string(), z.object({ username: z.string(), display_name: z.string() })),
  groups: z.record(z.string(), z.object({ path: z.string() })),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  sites: z.record(z.string(), ManifestSiteSchema),
});

type ManifestSite = z.infer<typeof ManifestSiteSchema>;
type ManifestItem = z.infer<typeof ManifestItemSchema>;

interface Corpus {
  sites: Map<string, Site>;
  directories: Map<string, Directory>;
  /** The manifest's sha256. */
  digest: string;
}

/** Every site in the corpus, and its directory. Reloading replaces them all. */
export class Workspace {
  sites = new Map<string, Site>();
  directories = new Map<string, Directory>();
  loaded = false;
  resets = 0;
  digest = "";

  constructor(
    readonly corpusDir: string,
    readonly worldPath: string,
  ) {}

  /**
   * Which corpus and which reset delta tokens belong to; tokens from another are refused. It's
   * deterministic, so a restart on the same corpus accepts tokens from before as long as its change
   * log repeats theirs (each token carries the log's digest).
   */
  get generation(): string {
    return `${this.digest.slice(0, 12)}-${this.resets}`;
  }

  load(): void {
    this.sites = new Map();
    this.directories = new Map();
    this.loaded = false;
    const corpus = loadCorpus(this.corpusDir, this.worldPath);
    this.sites = corpus.sites;
    this.directories = corpus.directories;
    this.digest = corpus.digest;
    this.loaded = true;
  }

  reset(): void {
    this.resets += 1;
    this.load();
  }

  siteForToken(token: string): string | null {
    const site = token.slice(TOKEN_PREFIX.length);
    return token.startsWith(TOKEN_PREFIX) && this.sites.has(site) ? site : null;
  }
}

export function loadCorpus(corpusDir: string, worldPath: string): Corpus {
  const path = join(corpusDir, "manifest.json");
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    throw new CorpusError(`can't read ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new CorpusError(`${path} isn't valid JSON: ${(error as Error).message}`);
  }
  const manifest = ManifestSchema.safeParse(data);
  if (!manifest.success) {
    const problems = manifest.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new CorpusError(`${path} doesn't match the manifest schema: ${problems.join("; ")}`);
  }
  let world;
  try {
    world = loadWorld(worldPath);
  } catch (error) {
    if (error instanceof WorldError) throw new CorpusError(`${worldPath}: ${error.problems.join("; ")}`);
    throw error;
  }

  const sites = new Map<string, Site>();
  const directories = new Map<string, Directory>();
  for (const [name, entry] of Object.entries(manifest.data.sites)) {
    sites.set(name, loadSite(name, entry, corpusDir));
    if (!Object.hasOwn(world.tenants, name)) throw new CorpusError(`${name}: world.yaml has no tenant '${name}'`);
    const directory = new Directory(world, name);
    if (!sameDirectory(entry, directory)) {
      throw new CorpusError(`${name}: the manifest's users and groups aren't world.yaml's; rebuild the corpus`);
    }
    directories.set(name, directory);
  }
  return { sites, directories, digest: sha256(raw) };
}

/** The manifest and the world agree on every user and group id. */
function sameDirectory(entry: ManifestSite, directory: Directory): boolean {
  const same = (a: string[], b: string[]) => JSON.stringify(a.sort()) === JSON.stringify(b.sort());
  return (
    same(
      Object.entries(entry.users).map(([id, user]) => `${id} ${user.username}`),
      directory.users.map((user) => `${user.id} ${user.username}`),
    ) &&
    same(
      Object.entries(entry.groups).map(([id, group]) => `${id} ${group.path}`),
      directory.groups.map((group) => `${group.id} ${group.path}`),
    )
  );
}

function loadSite(name: string, entry: ManifestSite, corpusDir: string): Site {
  const users = new Map(Object.entries(entry.users).map(([id, user]) => [id, user.display_name]));
  const groups = new Map(Object.entries(entry.groups).map(([id, group]) => [id, group.path]));
  const site = new Site(name, users, groups);
  for (const data of entry.items) {
    const item = loadItem(site, data, corpusDir);
    site.items.set(item.id, item);
    if (item.parentId === null) site.rootId = item.id;
  }
  if (!site.rootId) throw new CorpusError(`${name}: no root folder`);
  return site;
}

function loadItem(site: Site, entry: ManifestItem, corpusDir: string): Item {
  const fail = (problem: string) => new CorpusError(`${site.name}: ${entry.path}: ${problem}`);

  if (site.items.has(entry.id)) throw fail("duplicate id");
  const unknown = [entry.created_by, entry.modified_by].filter((u) => u !== null && !site.users.has(u));
  if (unknown.length) throw fail(`unknown users ${unknown.join(", ")}`);
  const strangers = site.strangers(entry.sharing.grants);
  if (strangers.length) {
    throw fail(`grants to principals the site doesn't have: ${strangers.map((g) => g.principal_name).join(", ")}`);
  }
  const item = new Item(
    entry.id,
    entry.name,
    entry.parent_id,
    entry.kind === "folder",
    entry.created,
    entry.modified,
    entry.created_by,
    entry.modified_by,
    entry.sharing,
  );
  if (entry.parent_id === null) {
    if (site.items.size || entry.path !== "/" || !item.folder)
      throw fail("the root must be the first item, a folder at /");
  } else {
    const parent = site.items.get(entry.parent_id);
    if (!parent?.folder) throw fail("its parent must be an earlier folder");
    if (`${site.path(parent).replace(/\/$/, "")}/${entry.name}` !== entry.path) {
      throw fail("its path doesn't match its parent's path and its name");
    }
    if (site.children(parent).some((c) => nameKey(c.name) === nameKey(entry.name))) {
      throw fail("a sibling has the same name");
    }
  }
  if (!entry.file !== item.folder) throw fail("files, and only files, have a `file`");
  if (entry.file) {
    const blob = blobPath(corpusDir, entry.file.blob);
    if (!blob) throw fail(`blob ${entry.file.blob} is missing`);
    item.mimeType = entry.file.mime_type;
    item.size = entry.file.size;
    item.sha256 = entry.file.sha256;
    item.blob = blob;
  }
  return item;
}

/** The blob's real path, if it's a file inside the corpus. */
function blobPath(corpusDir: string, blob: string): string | null {
  try {
    const path = realpathSync(resolve(corpusDir, blob));
    const inside = relative(realpathSync(corpusDir), path);
    return !inside.startsWith("..") && !isAbsolute(inside) && statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}
