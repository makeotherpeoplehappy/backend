// The places in the Webflow Locations collection (Copenhagen, The Hamptons, …):
// the "Near you" picker's choices, and where a suggested action works best.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import * as webflow from '../webflow';

export interface Place {
  id: string;
  slug: string;
  name: string;
}

const KEY = 'cfg:places';

/** Every live place, cached an hour. */
export async function listPlaces(env: Env, deps: Deps): Promise<Place[]> {
  const cached = (await env.CACHE.get(KEY, 'json')) as Place[] | null;
  if (cached) return cached;
  const places = (await webflow.listLiveItems(env, deps, CMS.locations.id)).map((i) => ({
    id: i.id,
    slug: String(i.fieldData.slug || ''),
    name: String(i.fieldData.name || ''),
  }));
  await env.CACHE.put(KEY, JSON.stringify(places), { expirationTtl: 3600 });
  return places;
}

export async function placeBySlug(env: Env, deps: Deps, slug: string | null | undefined): Promise<Place | null> {
  if (!slug) return null;
  return (await listPlaces(env, deps)).find((p) => p.slug === slug) || null;
}
