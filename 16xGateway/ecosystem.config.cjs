/* PM2 process file for 16xGateway. See docs/operations.md. */
module.exports = {
  apps: [
    {
      name: "16xgateway",
      script: "dist/src/server.js",
      instances: "max", // UDS listener shared via the cluster master
      exec_mode: "cluster",
      wait_ready: true, // server calls process.send('ready') once listening
      kill_timeout: 5000, // ≥ security.timeoutMs + 2000 so isolates drain on reload
      max_memory_restart: "512M",
      env: {
        GATEWAY_CONFIG: "/etc/16xgateway/gateway.config.json",
      },
    },
  ],
};
