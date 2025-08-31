const http = require('http');
const path = require('path');
const deployd = require('deployd');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3055;

async function start() {
  const server = http.createServer();

  // Attach Deployd to this HTTP server, pointing at this test app directory
  deployd.attach(server, {
    env: 'development',
    server_dir: process.cwd(),
    public_dir: path.join(process.cwd(), 'public'),
    db: { host: '127.0.0.1', port: 27017, name: 'deployd-dashboard-test' }
  });

  server.listen(PORT, () => {
    console.log(`Dev server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

