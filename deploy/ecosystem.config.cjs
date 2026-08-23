// pm2 process definition for the Truvian miner.
// Runs alongside existing pm2 apps without touching them:
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'truvian-miner',
      cwd: __dirname + '/..',
      script: 'node_modules/.bin/tsx',
      args: 'src/miner/server.ts',
      env: {
        PORT: 8787,
        HOST: '127.0.0.1', // nginx terminates TLS and proxies in; never exposed directly
        TRUVIAN_MINER_ID: 'truvian-onchain-truth',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      max_restarts: 20,
      restart_delay: 2000,
      time: true,
    },
  ],
};
