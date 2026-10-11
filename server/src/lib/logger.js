// Minimal structured logger: one JSON object per line on stdout.
// Structured logs can be searched and filtered by tools (e.g. jq, Datadog),
// unlike free-form console.log strings.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function log(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const line = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}
