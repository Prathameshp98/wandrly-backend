/** Place search and the trip map. */

import { Router } from 'express';

import { PlaceSearchQuery, TripIdParam, TripMapQuery } from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { accessOf, withTripRead } from '../../platform/http/withTripAccess';
import { placesService } from './places.service';

export const placesRouter = Router();

placesRouter.get('/places/search', validate({ query: PlaceSearchQuery }), async (req, res) => {
  const { q, limit } = validated.query(req, PlaceSearchQuery);
  res.json({ provider: placesService.providerName, items: await placesService.search(q, limit) });
});

placesRouter.get(
  '/trips/:tripId/map',
  validate({ params: TripIdParam, query: TripMapQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const { variantId } = validated.query(req, TripMapQuery);
    const result = await placesService.tripMap(accessOf(req), variantId);
    // The static-map URL embeds an API key and is deliberately NOT returned —
    // it is only ever used server-side, by the PDF export.
    res.json({ provider: placesService.providerName, ...result });
  },
);
