/**
 * Maps provider selection.
 *
 * Google when a key is present, OpenStreetMap otherwise. The default is the
 * free one deliberately: this project targets ₹0/month, and Google Maps is the
 * only dependency in the stack that requires a billing account.
 */

import { env } from '../config/env';
import { loggerFor } from '../logging/logger';
import { GoogleMapsProvider } from './google.provider';
import { NominatimProvider } from './nominatim.provider';
import type { MapsProvider } from './provider';

const log = loggerFor('maps');

function select(): MapsProvider {
  if (env.GOOGLE_MAPS_API_KEY) {
    log.info('using Google Maps Platform for places and geocoding');
    return new GoogleMapsProvider();
  }

  log.info('using OpenStreetMap/Nominatim (no GOOGLE_MAPS_API_KEY configured)');
  return new NominatimProvider();
}

export const maps: MapsProvider = select();
export type { MapsProvider, Place } from './provider';
