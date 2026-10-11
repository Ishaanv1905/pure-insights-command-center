// Read-side and admin operations on reports.

import { badRequest, notFound } from '../lib/errors.js';
import { REFRESH_STATUSES, FLAGS, withOwnershipFlag } from './readingValidator.js';
import { transaction } from '../db/database.js';
import { parseFlags } from '../repositories/mappers.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createReportService({ db, repos, events }) {
  const { reports, readings } = repos;

  // Assignment and the flag recomputation it implies happen together or not at all.
  const assignAndReflag = transaction(db, (reportId, email) => {
    reports.assignOwner(reportId, email);
    const row = reports.findRawById(reportId);
    reports.setFlags(reportId, withOwnershipFlag(parseFlags(row.flags), Boolean(row.effective_owner_email)));
  });

  return {
    list(filters) {
      if (filters.status && !REFRESH_STATUSES.includes(filters.status)) {
        throw badRequest(`status must be one of ${REFRESH_STATUSES.join(', ')}`);
      }
      if (filters.flag && !Object.values(FLAGS).includes(filters.flag)) {
        throw badRequest(`flag must be one of ${Object.values(FLAGS).join(', ')}`);
      }
      return reports.list(filters);
    },

    get(reportId) {
      const report = reports.findById(reportId);
      if (!report) throw notFound(`Report ${reportId} not found`);
      return report;
    },

    readings(reportId, page) {
      this.get(reportId); // 404 if the report does not exist
      return readings.listForReport(reportId, page);
    },

    /** Admin action: give an orphaned report an owner (or clear the assignment with null). */
    assignOwner(reportId, email) {
      this.get(reportId);
      if (email !== null && (typeof email !== 'string' || !EMAIL_RE.test(email.trim()))) {
        throw badRequest('owner_email must be a valid email address, or null to clear the assignment');
      }
      assignAndReflag(reportId, email === null ? null : email.trim().toLowerCase());
      const updated = reports.findById(reportId);
      events.publish('report.updated', updated);
      return updated;
    },
  };
}
