// /api/alerts - alert history and acknowledgement.
// The browser loads recent alerts here on page load, then listens on the
// WebSocket for new ones, so nothing is missed while it was disconnected.

import { Router } from 'express';
import { page, parseId, parsePagination } from '../lib/query.js';

export function alertRoutes({ services }, { requirePermission }) {
  const router = Router();

  router.get('/', requirePermission('alerts:read'), (req, res) => {
    const pagination = parsePagination(req.query);
    const { status, severity, rule, report_id: reportId } = req.query;
    res.json(page(services.alerts.list({ status, severity, rule, reportId, ...pagination }), pagination));
  });

  router.get('/:id', requirePermission('alerts:read'), (req, res) => {
    res.json(services.alerts.get(parseId(req.params.id)));
  });

  router.post('/:id/acknowledge', requirePermission('alerts:acknowledge'), (req, res) => {
    res.json(services.alerts.acknowledge(parseId(req.params.id), req.user));
  });

  return router;
}
