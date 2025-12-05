# Dockerfile for OpenCV Structural Validator Microservice
# Optimized for Railway deployment

FROM python:3.11-slim

# Install system dependencies for OpenCV
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .

# Expose port (Railway will override with PORT env var)
EXPOSE 8000

# Run FastAPI with Uvicorn
# Use shell form to allow environment variable expansion
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
