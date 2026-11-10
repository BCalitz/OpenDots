// Windows only: the Android SDK's CMake 3.22.1 ships ninja 1.10, which fails
// on build paths longer than 260 characters (react-native-gesture-handler hits
// this). If mobile/.tools/cmake exists (a copy of the SDK CMake with ninja
// 1.12+ in bin/), point this app's native build at it. Other platforms and
// machines without the folder are unaffected.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function withLocalCmake(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const root = config.modRequest.projectRoot;
      const cmake = path.join(root, '.tools', 'cmake');
      if (process.platform !== 'win32' || !fs.existsSync(cmake)) return config;
      const file = path.join(
        config.modRequest.platformProjectRoot,
        'local.properties',
      );
      const existing = fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith('cmake.dir='))
        : [];
      // local.properties uses Java properties escaping: forward slashes are safe.
      existing.push(`cmake.dir=${cmake.replace(/\\/g, '/')}`);
      fs.writeFileSync(file, `${existing.join('\n')}\n`);
      return config;
    },
  ]);
};
