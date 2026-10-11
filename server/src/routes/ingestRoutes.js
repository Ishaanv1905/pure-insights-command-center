// /api/ingest - machine-to-machine telemetry intake (API key, not user login).
// POST is used because the sender HANDS OVER data that creates a new record.

import { Router } from 'express';

export function ingestRoutes({ services }, { requireApiKey }) {
  const router = Router();
  router.use(requireApiKey);

  // One reading. Optional "Idempotency-Key" header makes retries safe.
  router.post('/', (req, res) => {
    const result = services.ingest.ingestOne(req.body, req.get('idempotency-key'));
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  // Many readings in one request (each is validated and stored independently).
  router.post('/batch', (req, res) => {
    res.status(200).json(services.ingest.ingestBatch(req.body));
  });

  return router;
}
