// PM2 on the VPS: pm2 start deploy/ecosystem.config.cjs && pm2 save
// Listens on 127.0.0.1 only; nginx (deploy/nginx-nukyok.conf) is the public side.
// Next reads /home/ubuntu/nukyok/.env itself at start.
module.exports = {
  apps: [
    {
      name: "nukyok-web",
      cwd: "/home/ubuntu/nukyok",
      script: "node_modules/next/dist/bin/next",
      args: "start -H 127.0.0.1 -p 3004",
      env: { NODE_ENV: "production" },
      max_memory_restart: "600M",
    },
  ],
};
