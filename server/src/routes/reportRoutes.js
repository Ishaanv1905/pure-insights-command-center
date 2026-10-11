// /api/reports - report inventory, orphaned reports, history, owner assignment.

import { Router } from 'express';
import { page, parseBoolean, parsePagination } from '../lib/query.js';
import { badRequest } from '../lib/errors.js';

export function reportRoutes({ services }, { requirePermission }) {
  const router = Router();

  router.get('/', requirePermission('reports:read'), (req, res) => {
    const pagination = parsePagination(req.query);
    const { search, status, flag, sort, order } = req.query;
    const orphaned = parseBoolean(req.query.orphaned, 'orphaned');
    res.json(page(services.reports.list({ search, status, flag, orphaned, sort, order, ...pagination }), pagination));
  });

  // Convenience endpoint for the Orphaned page (same as ?orphaned=true).
  router.get('/orphaned', requirePermission('reports:read'), (req, res) => {
    const pagination = parsePagination(req.query);
    res.json(page(services.reports.list({ orphaned: true, ...pagination }), pagination));
  });

  router.get('/:reportId', requirePermission('reports:read'), (req, res) => {
    res.json(services.reports.get(req.params.reportId));
  });

  router.get('/:reportId/readings', requirePermission('readings:read'), (req, res) => {
    const pagination = parsePagination(req.query);
    res.json(page(services.reports.readings(req.params.reportId, pagination), pagination));
  });

  router.patch('/:reportId/owner', requirePermission('reports:assign-owner'), (req, res) => {
    if (!req.body || !('owner_email' in req.body)) throw badRequest('owner_email is required (use null to clear)');
    res.json(services.reports.assignOwner(req.params.reportId, req.body.owner_email));
  });

  return router;
}
