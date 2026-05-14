module.exports = {
  apps: [
    {
      name: 'hyperedit-backend',
      cwd: './backend',
      script: 'scripts/local-ffmpeg-server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3333
      },
      max_memory_restart: '4G',
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 5000,
    },
    {
      name: 'hyperedit-frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/vite',
      args: 'preview --host 0.0.0.0 --port 5173 --strictPort',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '2G',
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      merge_logs: true,
      time: true,
    }
  ]
};
