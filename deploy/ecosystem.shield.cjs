// pm2 process definition for Truvian Shield (Track 3).
// SEPARATE file from ecosystem.config.cjs so miner and Shield can be
// started/reloaded independently:
//   pm2 start deploy/ecosystem.shield.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'truvian-shield',
      cwd: __dirname + '/..', // repo root (= /opt/truvian on the VPS)
      script: 'node_modules/.bin/tsx',
      args: 'src/shield/server.ts',
      env: {
        PORT: 8788,
        HOST: '127.0.0.1', // nginx terminates TLS and proxies in; never exposed directly

        // TELEGRAPH_PAYER_KEY: '0x<base-sepolia-burner-private-key>',
        //   Pays x402 fees (USDC on Base Sepolia) for live Telegraph miner
        //   queries. Do NOT commit a real key. Set it on the VPS only, either:
        //     a) export TELEGRAPH_PAYER_KEY=0x… in the shell, then
        //        pm2 restart truvian-shield --update-env
        //     b) or put it in /opt/truvian/.env (dotenv is already a repo
        //        dependency) and keep .env out of git.

        // SHIELD_TRANSPORT: 'x402',
        //   Optional override. Defaults to 'x402' whenever TELEGRAPH_PAYER_KEY
        //   is set, else 'direct' (free catalog base_urls — still real
        //   Telegraph miners, labeled in every check). See src/shield/telegraph.ts.
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
