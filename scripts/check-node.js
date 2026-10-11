// Fails fast with a clear message when Node.js is too old.
// Written in plain CommonJS-compatible syntax so it runs on any Node version.
// The app needs Node 22.13+ for the built-in SQLite module (node:sqlite),
// the --env-file-if-exists flag and glob patterns in the test runner.

var REQUIRED_MAJOR = 22;
var REQUIRED_MINOR = 13;

var parts = process.versions.node.split('.').map(Number);
var major = parts[0];
var minor = parts[1];
var ok = major > REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor >= REQUIRED_MINOR);

if (!ok) {
  console.error(
    '\n  Node.js ' +
      REQUIRED_MAJOR +
      '.' +
      REQUIRED_MINOR +
      ' or newer is required (you have ' +
      process.version +
      ').\n' +
      '  Install Node 22 LTS or 24 LTS:\n' +
      '    macOS / Linux (nvm):   nvm install 22 && nvm use 22\n' +
      '    Windows (nvm-windows): nvm install 22 && nvm use 22\n' +
      '    or download the LTS installer from https://nodejs.org\n' +
      '  Then delete any node_modules folders and run "npm run setup" again.\n',
  );
  process.exit(1);
}
