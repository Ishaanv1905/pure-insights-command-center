// /api/users - user management (admin only).

import { Router } from 'express';
import { parseId } from '../lib/query.js';

export function userRoutes({ services }, { requirePermission }) {
  const router = Router();
  router.use(requirePermission('users:manage'));

  router.get('/', (_req, res) => {
    res.json({ items: services.auth.listUsers() });
  });

  router.post('/', async (req, res) => {
    res.status(201).json(await services.auth.createUser(req.body));
  });

  router.patch('/:id', (req, res) => {
    res.json(services.auth.changeRole(parseId(req.params.id), req.body?.role, req.user.id));
  });

  return router;
}
