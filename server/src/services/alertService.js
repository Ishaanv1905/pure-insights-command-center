// Read and acknowledge alerts. Creating and resolving alerts happens only in the
// ingest pipeline, driven by data - never by hand.

import { badRequest, conflict, notFound } from '../lib/errors.js';
import { RULES } from './alertEngine.js';

const STATUSES = ['active', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const SEVERITIES = ['warning', 'critical'];

export function createAlertService({ repos, events, clock }) {
  const { alerts } = repos;

  return {
    list(filters) {
      if (filters.status && !STATUSES.includes(filters.status)) {
        throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
      }
      if (filters.severity && !SEVERITIES.includes(filters.severity)) {
        throw badRequest(`severity must be one of ${SEVERITIES.join(', ')}`);
      }
      if (filters.rule && !Object.values(RULES).includes(filters.rule)) {
        throw badRequest(`rule must be one of ${Object.values(RULES).join(', ')}`);
      }
      return alerts.list(filters);
    },

    get(id) {
      const alert = alerts.findById(id);
      if (!alert) throw notFound(`Alert ${id} not found`);
      return alert;
    },

    acknowledge(id, user) {
      const alert = this.get(id);
      if (alert.status !== 'OPEN') {
        throw conflict(`Only OPEN alerts can be acknowledged (this one is ${alert.status})`);
      }
      alerts.acknowledge(id, user.email, clock().toISOString());
      const updated = alerts.findById(id);
      events.publish('alert.updated', { ...updated, change: 'acknowledged' });
      return updated;
    },
  };
}
