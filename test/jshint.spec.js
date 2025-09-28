var path = require('path');
var spawnSync = require('child_process').spawnSync;

describe('JSHint', function() {
  this.timeout(20000);

  it('passes configured lint rules', function() {
    var result = spawnSync(process.execPath, [
      require.resolve('jshint/bin/jshint'),
      '.'
    ], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });

    var output = '';
    if (result.stdout) {
      output += result.stdout.toString();
    }
    if (result.stderr) {
      output += result.stderr.toString();
    }

    if (result.status !== 0) {
      throw new Error('JSHint reported issues:\n' + output.trim());
    }
  });
});
