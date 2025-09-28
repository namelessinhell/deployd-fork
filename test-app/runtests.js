var fs = require('fs');
var path = require('path');
var MongoMemoryServer = require('mongodb-memory-server').MongoMemoryServer;
var puppeteer = require('puppeteer');
var createServer = require('../');

var server;
var mongoServer;

if (!fs.existsSync('app.dpd')) {
  console.log('Not a deployd app directory, please run this from a deployd app directory');
  process.exit(1);
  return;
}

console.log('Running integration tests');
console.log('');

if (fs.existsSync('data')) {
  console.log('Removing previous data directory');
  fs.rmSync('data', { recursive: true, force: true });
}

function generatePort() {
  const portRange = [3000, 9000];
  return Math.floor(Math.random() * (portRange[1] - portRange[0])) + portRange[0];
}

function stopMongo() {
  if (mongoServer) {
    mongoServer.stop().catch(function(err) {
      console.error('Failed to stop in-memory MongoDB:', err);
    });
    mongoServer = null;
  }
}

async function main() {
  // Spin up an in-memory MongoDB so tests do not rely on a system mongod binary.
  var mongoPort = generatePort();
  try {
    mongoServer = await MongoMemoryServer.create({
      instance: {
        port: mongoPort,
        ip: '127.0.0.1',
        dbName: 'deployd-integration'
      }
    });
  } catch (err) {
    console.error('Failed to start in-memory MongoDB:', err);
    process.exit(1);
    return;
  }

  var serverPort = generatePort();

  try {
    server = await startServer({
      port: serverPort,
      host: '127.0.0.1',
      env: 'development',
      db: {
        host: mongoServer.instanceInfo.ip,
        port: mongoServer.instanceInfo.port,
        name: 'deployd-integration'
      }
    });
  } catch (err) {
    console.error('Failed to start deployd server:', err);
    stopMongo();
    process.exit(1);
    return;
  }

  let browserResult;
  try {
    browserResult = await runBrowserTests(serverPort);
  } catch (err) {
    console.error('Failed running browser tests:', err);
    await shutdown(1);
    return;
  }

  var exitCode = browserResult && browserResult.failures > 0 ? 1 : 0;
  if (browserResult && browserResult.stats) {
    console.log('Browser tests complete:', browserResult.stats.tests + ' tests, ' + browserResult.stats.failures + ' failures');
    if (browserResult.stats.failures > 0 && browserResult.failureTitles && browserResult.failureTitles.length) {
      console.log('Sample browser failures:', browserResult.failureTitles.slice(0, 3).join(' | '));
    }
  }

  await shutdown(exitCode);
}

async function startServer(options) {
  return await new Promise(function(resolve, reject) {
    var serverInstance = createServer(options);
    serverInstance.once('listening', function() {
      resolve(serverInstance);
    });
    serverInstance.once('error', function(err) {
      reject(err);
    });
    serverInstance.listen(options.port, options.host);
  });
}

async function runBrowserTests(port) {
  var browser = await puppeteer.launch({ headless: 'new' });
  try {
    var page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    page.on('pageerror', function(err) {
      console.error('Browser error:', err);
    });

    await page.evaluateOnNewDocument(function() {
      window.__mochaDoneFlag = false;
      window.__mochaResults = null;

      window.initMochaPhantomJS = function() {
        var originalRun = mocha.run.bind(mocha);
        mocha.run = function() {
          var runner = originalRun.apply(this, arguments);
          runner.on('end', function() {
            window.__mochaResults = {
              stats: {
                tests: runner.stats && runner.stats.tests || 0,
                passes: runner.stats && runner.stats.passes || 0,
                failures: runner.stats && runner.stats.failures || 0,
                pending: runner.stats && runner.stats.pending || 0,
                duration: runner.stats && runner.stats.duration || 0,
                start: runner.stats && runner.stats.start || null,
                end: runner.stats && runner.stats.end || null
              },
              failures: typeof runner.failures === 'number' ? runner.failures : runner.stats && runner.stats.failures || 0
            };
            window.__mochaDoneFlag = true;
          });
          return runner;
        };
      };
    });

    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'domcontentloaded', timeout: 60000 });

    var timeoutMs = 600000;
    var start = Date.now();
    var lastState = null;

    while (Date.now() - start < timeoutMs) {
      var state = await page.evaluate(function() {
        function parseCount(selector) {
          var el = document.querySelector(selector);
          if (!el) return 0;
          var value = parseInt(el.textContent, 10);
          return isNaN(value) ? 0 : value;
        }

        var failureTitles = Array.prototype.slice.call(document.querySelectorAll('#mocha-report .fail h2')).map(function(node) {
          return node.innerText;
        });
        var failureMessages = Array.prototype.slice.call(document.querySelectorAll('#mocha-report .fail pre.error')).map(function(node) {
          return node.innerText;
        });

        return {
          done: window.__mochaDoneFlag === true,
          results: window.__mochaResults,
          summary: {
            tests: parseCount('#mocha-stats .tests em'),
            passes: parseCount('#mocha-stats .passes em'),
            failures: parseCount('#mocha-stats .failures em'),
            pending: parseCount('#mocha-stats .pending em')
          },
          failureTitles: failureTitles.slice(0, 5),
          failureMessages: failureMessages.slice(0, 5)
        };
      });

      lastState = state;

      if (state.done && state.results) {
        var extras = await page.evaluate(function() {
          return {
            failureTitles: Array.prototype.slice.call(document.querySelectorAll('#mocha-report .fail h2')).map(function(node) {
              return node.innerText;
            }),
            failureMessages: Array.prototype.slice.call(document.querySelectorAll('#mocha-report .fail pre.error')).map(function(node) {
              return node.innerText;
            })
          };
        });
        state.results.failureTitles = extras.failureTitles;
        state.results.failureMessages = extras.failureMessages;
        return state.results;
      }

      await new Promise(function(resolve) {
        setTimeout(resolve, 3000);
      });
    }

    var errorMessage = 'Timed out waiting for browser tests to finish';
    if (lastState && lastState.summary) {
      errorMessage += ' (tests ' + lastState.summary.tests + ', passes ' + lastState.summary.passes + ', failures ' + lastState.summary.failures + ')';
    }
    var error = new Error(errorMessage);
    if (lastState && lastState.failureTitles && lastState.failureTitles.length) {
      error.failures = lastState.failureTitles;
      error.failureMessages = lastState.failureMessages;
    }
    throw error;
  } finally {
    await browser.close();
  }
}

async function shutdown(code) {
  try {
    if (server) {
      await new Promise(function(resolve) {
        server.close(function() {
          resolve();
        });
      });
      server = null;
    }
  } catch (err) {
    console.error('Failed to stop deployd server:', err);
  }

  stopMongo();
  process.exit(code);
}

main();
