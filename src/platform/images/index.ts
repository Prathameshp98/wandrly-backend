/**
 * Image provider registry.
 *
 * One provider today. The registry exists because adding Unsplash later means
 * supporting REFERENCE mode alongside IMPORT, and that is a per-provider fact
 * the media service must be able to ask about — not a global switch.
 */

import { PexelsProvider } from './pexels.provider';
import type { ImageProvider } from './provider';

const providers = new Map<string, ImageProvider>();

const pexels = new PexelsProvider();
providers.set(pexels.name, pexels);

export function providerByName(name: string): ImageProvider | null {
  return providers.get(name) ?? null;
}

/** Providers that actually have credentials, for the picker's source list. */
export function configuredProviders(): ImageProvider[] {
  return [...providers.values()].filter((provider) => provider.isConfigured);
}

export const defaultProvider = (): ImageProvider => pexels;

export type { AttachMode, ImageProvider, ProviderPhoto, SearchResult } from './provider';
