# 🚀 DEPLOYMENT GUIDE

Complete guide to deploy the Flask AI Attendance System to production.

---

## 📋 Prerequisites

- **OS**: Windows Server, Linux, or Docker
- **Hardware**: 4GB RAM minimum, 8GB recommended for GPU
- **Python**: 3.8+
- **GPU** (optional): NVIDIA GPU with CUDA 11.8+

---

## 🐳 Docker Deployment (Recommended)

### Option 1: Docker CLI

```bash
# Build image
docker build -t attendance-app:latest .

# Run container
docker run -d \
  --name attendance \
  -p 5000:5000 \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/models:/app/models \
  -v $(pwd)/attendance.db:/app/attendance.db \
  attendance-app:latest

# Check logs
docker logs -f attendance

# Access
http://localhost:5000
```

### Option 2: Docker Compose

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f attendance-app

# Access
http://localhost:5000
```

---

## 🖥️ Windows Deployment

### Option 1: Standalone EXE (Using PyInstaller)

```bash
# Install PyInstaller
pip install pyinstaller

# Create executable
pyinstaller --onefile --add-data "templates:templates" app.py

# Run
dist\app.exe

# Access
http://localhost:5000
```

### Option 2: Windows Service

```bash
# Install NSSM (Non-Sucking Service Manager)
# Download from: nssm.cc

# Install service
nssm install AttendanceApp C:\path\to\venv\Scripts\python.exe C:\path\to\app.py

# Start service
nssm start AttendanceApp

# Stop service
nssm stop AttendanceApp

# Remove service
nssm remove AttendanceApp
```

---

## 🐧 Linux Deployment

### Using systemd

**1. Create service file:**

```bash
sudo nano /etc/systemd/system/attendance.service
```

**Content:**

```ini
[Unit]
Description=Flask AI Attendance System
After=network.target

[Service]
Type=notify
User=attendance
WorkingDirectory=/home/attendance/Flask-Attedence
Environment="PATH=/home/attendance/Flask-Attedence/venv/bin"
ExecStart=/home/attendance/Flask-Attedence/venv/bin/python app.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**2. Enable and start:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable attendance
sudo systemctl start attendance
sudo systemctl status attendance
```

**3. View logs:**

```bash
sudo journalctl -u attendance -f
```

---

## 🔒 Production Configuration

### 1. Environment Variables

Create `.env` file:

```env
FLASK_ENV=production
FLASK_DEBUG=0
PYTHONUNBUFFERED=1
LOG_LEVEL=INFO
ENABLE_GPU=false
FACE_MATCHING_THRESHOLD=0.6
```

### 2. Reverse Proxy (NGINX)

```nginx
server {
    listen 80;
    server_name attendance.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        
        # Timeouts for large uploads
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }
}
```

### 3. SSL/HTTPS (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certbot --nginx -d attendance.example.com
```

Updated NGINX config:

```nginx
server {
    listen 443 ssl http2;
    server_name attendance.example.com;
    
    ssl_certificate /etc/letsencrypt/live/attendance.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/attendance.example.com/privatekey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        # ... rest of config
    }
}

server {
    listen 80;
    server_name attendance.example.com;
    return 301 https://$server_name$request_uri;
}
```

### 4. Production WSGI Server (Gunicorn)

```bash
pip install gunicorn

# Run with 4 workers
gunicorn --workers 4 --worker-class sync --bind 0.0.0.0:5000 app:app
```

**systemd service with Gunicorn:**

```ini
[Service]
ExecStart=/home/attendance/venv/bin/gunicorn --workers 4 --worker-class sync --bind 0.0.0.0:5000 app:app
```

---

## 📊 Database Backup

### Automated Daily Backup

**Linux (cron):**

```bash
# Edit crontab
crontab -e

# Add line (daily backup at 2 AM)
0 2 * * * cp /path/to/attendance.db /backup/attendance_$(date +\%Y\%m\%d).db
```

**Windows (Task Scheduler):**

```powershell
# PowerShell script: backup.ps1
$timestamp = Get-Date -Format "yyyyMMdd"
Copy-Item "C:\attendance\attendance.db" "C:\backup\attendance_$timestamp.db"
```

---

## 🔧 Monitoring & Logging

### Application Logs

Logs are automatically stored in `logs/attendance.log` with rotation.

### System Monitoring

```bash
# View CPU/Memory
docker stats attendance

# Or with systemd
watch -n 1 'ps aux | grep app.py'
```

### Log Aggregation (Optional)

```bash
# Install ELK Stack
docker-compose up -d elasticsearch kibana logstash

# Send logs to ELK
python app.py | logstash -f config.conf
```

---

## 🚨 Security Checklist

- [ ] HTTPS enabled (SSL/TLS)
- [ ] Firewall configured (allow only 5000, 80, 443)
- [ ] Database backups enabled
- [ ] Log rotation configured
- [ ] Regular security updates
- [ ] Rate limiting enabled (add to Flask app)
- [ ] CORS properly configured
- [ ] API authentication (if needed)
- [ ] Database encryption at rest
- [ ] Network isolation (private subnet)

### Add Rate Limiting

```bash
pip install Flask-Limiter

# In app.py
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(app, key_func=get_remote_address)

@app.route('/api/recognize/frame', methods=['POST'])
@limiter.limit("10 per minute")
def recognize_face_frame():
    # ...
```

---

## 📈 Performance Optimization

### 1. GPU Acceleration

Enable CUDA for faster inference:

```python
# In config.py
ENABLE_GPU = True
```

Install CUDA 11.8:
https://developer.nvidia.com/cuda-11-8-0-download

### 2. Model Quantization (Optional)

Use smaller YOLO model for faster inference:

```python
# In config.py
YOLO_MODEL = 'yolov8n.pt'  # nano (fastest)
# YOLO_MODEL = 'yolov8s.pt'  # small
# YOLO_MODEL = 'yolov8m.pt'  # medium (more accurate)
```

### 3. Load Balancing (Multiple Instances)

```nginx
upstream attendance_backend {
    server 127.0.0.1:5001;
    server 127.0.0.1:5002;
    server 127.0.0.1:5003;
    server 127.0.0.1:5004;
}

server {
    listen 80;
    server_name attendance.example.com;
    
    location / {
        proxy_pass http://attendance_backend;
    }
}
```

---

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Windows
netstat -ano | findstr :5000
taskkill /PID <PID> /F

# Linux
lsof -i :5000
kill -9 <PID>
```

### Out of Memory

```bash
# Reduce model size or worker count
gunicorn --workers 2 --max-requests 1000 app:app
```

### GPU Not Detected

```bash
# Check CUDA
python -c "import torch; print(torch.cuda.is_available())"

# Fallback to CPU
ENABLE_GPU=false python app.py
```

---

## 📞 Support

- Check logs: `logs/attendance.log`
- Health check: `http://localhost:5000/api/health`
- Database issues: Verify `attendance.db` permissions
- Models not loading: Re-run `python download_models.py`

---

**Ready for production! 🎉**
