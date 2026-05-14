# HyperEdit Deployment Guide

## 1. Architecture

```
User Browser
     │
     ├── http://your-server:5173 (Vite Dev - development)
     │       └── Vite proxy forwards /session/* → backend:3333
     │
     └── http://your-server:80 (Nginx - production)
             ├── / → frontend/dist (static files)
             ├── /session/* → proxy localhost:3333
             ├── /api/*      → proxy localhost:3333
             └── /health     → proxy localhost:3333
```

## 2. Prerequisites (Ubuntu 26.04)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install FFmpeg (required for video processing)
sudo apt install -y ffmpeg

# Verify
node --version    # Should be v22.x
npm --version     # Should be 10.x
ffmpeg -version  # Should show version
ffprobe -version # Should show version
```

## 3. One-Command Deploy (Quick Start)

```bash
# Clone
git clone https://github.com/pratikkshirsagar832-ctrl/HyperEditor.git
cd HyperEditor

# Set API keys
nano backend/.dev.vars

# Run
chmod +x start.sh
./start.sh
```

Frontend: http://localhost:5173
Backend:  http://localhost:3333/health

## 4. Production Deploy (Nginx + PM2)

### 4.1 Install PM2 for process management
```bash
sudo npm install -g pm2
```

### 4.2 Build frontend
```bash
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..
```

### 4.3 Install backend
```bash
cd backend
npm install
cd ..
```

### 4.4 Create PM2 ecosystem file

```bash
nano ecosystem.config.cjs
```

```javascript
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
      time: true,
    },
    {
      name: 'hyperedit-frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/vite',
      args: 'preview --host 0.0.0.0 --port 5173',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      time: true,
    }
  ]
};
```

### 4.5 Start with PM2
```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # Auto-start on server reboot
```

### 4.6 Install & Configure Nginx

```bash
sudo apt install -y nginx
```

Create nginx config:

```bash
sudo nano /etc/nginx/sites-available/hyperedit
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Increase upload size for videos (100GB max)
    client_max_body_size 100G;
    proxy_request_buffering off;
    proxy_buffering off;

    # Frontend static files
    root /path/to/HyperEditor/frontend/dist;
    index index.html;

    # API proxy to backend
    location /session/ {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3333;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3333;
    }

    location /assets/ {
        proxy_pass http://127.0.0.1:3333;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/hyperedit /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 4.7 (Optional) HTTPS with Let's Encrypt
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 5. Environment Variables

File: `backend/.dev.vars`

```bash
# Required
DEEPSEEK_API_KEY=sk-xxx          # AI animations, chapters, segments
GROQ_API_KEY=gsk_xxx              # Whisper transcription

# Optional (features will gracefully degrade if missing)
FAL_API_KEY=fal_xxx               # Image/video generation (Picasso/DiCaprio)
GIPHY_API_KEY=xxx                 # GIF search
```

File: `frontend/.env.production`

```env
VITE_BACKEND_URL=http://localhost:3333   # Backend URL (use nginx URL in prod)
```

## 6. Troubleshooting

### Backend won't start
```bash
# Check if ffmpeg is installed
ffmpeg -version

# Check port is free
sudo lsof -i :3333

# Check logs
pm2 logs hyperedit-backend
```

### Upload fails
```bash
# Check disk space
df -h

# Check /tmp directory is writable
ls -la /tmp/hyperedit-ffmpeg

# Increase nginx upload limit (already set above)
```

### Frontend can't reach backend
```bash
# Test backend directly
curl http://localhost:3333/health

# Test through nginx
curl http://localhost/session/create -X POST
```

## 7. Useful Commands

```bash
# View logs
pm2 logs hyperedit-backend
pm2 logs hyperedit-frontend

# Restart services
pm2 restart hyperedit-backend
pm2 restart hyperedit-frontend

# Stop everything
pm2 stop all

# Monitor resources
pm2 monit

# Update code
git pull
cd frontend && npm install && npm run build
pm2 restart all
```
