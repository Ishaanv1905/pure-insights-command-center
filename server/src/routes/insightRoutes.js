// /api/health, /api/cost, /api/data-quality - aggregated read-only views.

import { Router } from 'express';

export function insightRoutes({ services }, { requirePermission }) {
  const router = Router();

  router.get('/health/summary', requirePermission('health:read'), (_req, res) => {
    res.json(services.insights.healthSummary());
  });

  router.get('/cost', requirePermission('cost:read'), (_req, res) => {
    res.json(services.cost.getCostReport());
  });

  router.get('/cost/usage-mismatch', requirePermission('cost:read'), (_req, res) => {
    res.json(services.cost.getUsageMismatch());
  });

  router.get('/data-quality', requirePermission('data-quality:read'), (_req, res) => {
    res.json(services.insights.dataQuality());
  });

  return router;
}
