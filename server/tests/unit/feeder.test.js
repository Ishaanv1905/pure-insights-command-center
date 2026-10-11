// The feeder lives in its own folder; these tests cover its CSV parsing and type conversion.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../../feeder/csv.js';
import { rowToReading } from '../../../feeder/feeder.js';

describe('feeder CSV handling', () => {
  test('parses header + rows, quoted commas and escaped quotes, CRLF', () => {
    const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,z\r\n');
    assert.deepEqual(rows, [
      { a: '1', b: 'x, y', c: 'say "hi"' },
      { a: '2', b: '', c: 'z' },
    ]);
  });

  test('rowToReading converts numbers and keeps dirty owner values as-is', () => {
    const reading = rowToReading({
      report_id: 'RPT_203',
      report_name: 'Analytics Dashboard 4',
      owner_email: 'nan',
      last_refresh_status: 'TIMED_OUT',
      monthly_active_views: '706',
      snowflake_credits_consumed: '74.59',
      avg_load_time_sec: '17.8',
      aws_hosting_cost_usd: '164.0',
      query_count_last_30d: '5626',
      concurrent_user_peak: '130',
    });
    assert.equal(reading.owner_email, 'nan'); // the server, not the feeder, decides what "nan" means
    assert.equal(reading.avg_load_time_sec, 17.8);
    assert.equal(reading.monthly_active_views, 706);
  });

  test('empty numeric cells become null so the server rejects them', () => {
    const reading = rowToReading({ report_id: 'X', last_refresh_status: 'SUCCESS', avg_load_time_sec: '' });
    assert.equal(reading.avg_load_time_sec, null);
  });
});
