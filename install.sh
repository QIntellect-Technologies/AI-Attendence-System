#!/bin/bash

# Flask AI Attendance System - Installation Script
# Works on Linux and macOS

set -e

echo "🚀 Flask AI Attendance System - Installation"
echo "============================================="

# Check Python version
echo "✓ Checking Python installation..."
python3 --version

# Create virtual environment
echo "✓ Creating virtual environment..."
python3 -m venv venv
source venv/bin/activate

# Upgrade pip
echo "✓ Upgrading pip..."
pip install --upgrade pip

# Install dependencies
echo "✓ Installing dependencies..."
pip install -r requirements.txt

# Create directories
echo "✓ Creating required directories..."
mkdir -p logs uploads models

# Download models
echo "✓ Downloading AI models (this may take a few minutes)..."
python download_models.py

# Initialize database
echo "✓ Initializing database..."
python -c "from database import init_db; init_db()"

# Run tests
echo "✓ Running test suite..."
python test.py

echo ""
echo "============================================="
echo "✅ Installation Complete!"
echo "============================================="
echo ""
echo "To start the server:"
echo "  python app.py"
echo ""
echo "Then access:"
echo "  http://localhost:5000"
echo ""
echo "Documentation:"
echo "  - QUICKSTART.md - Quick setup guide"
echo "  - README.md - Full documentation"
echo "  - API_REFERENCE.md - API endpoints"
echo "  - DEPLOYMENT.md - Production deployment"
echo ""
