# OpenCV Structural Validator Microservice

FastAPI-based microservice for validating structural integrity of real estate images using OpenCV line detection.

## Features

- **Line Detection**: Uses Canny edge detection + Hough Line Transform
- **Architectural Analysis**: Detects vertical (walls, doors) and horizontal (ceiling, floor) lines
- **Structural Scoring**: Computes deviation between original and enhanced images
- **Configurable Thresholds**: Adjustable sensitivity for different use cases

## API Endpoints

### `POST /validate-structure`

Validate structural integrity between two images.

**Request:**
```json
{
  "originalUrl": "https://s3.amazonaws.com/bucket/original.jpg",
  "enhancedUrl": "https://s3.amazonaws.com/bucket/enhanced.jpg",
  "sensitivity": 5.0  // Optional, default: 5.0
}
```

**Response:**
```json
{
  "original": {
    "count": 145,
    "verticalCount": 67,
    "horizontalCount": 52,
    "avgVerticalAngle": 89.3,
    "avgHorizontalAngle": 1.2
  },
  "enhanced": {
    "count": 142,
    "verticalCount": 65,
    "horizontalCount": 51,
    "avgVerticalAngle": 89.1,
    "avgHorizontalAngle": 1.5
  },
  "verticalShift": 0.2,
  "horizontalShift": 0.3,
  "deviationScore": 0.5,
  "isSuspicious": false,
  "message": "Structural validation passed: 0.50° deviation"
}
```

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy"
}
```

## Local Development

### Prerequisites
- Python 3.11+
- pip

### Installation

```bash
cd opencv-validator
pip install -r requirements.txt
```

### Run Locally

```bash
python app.py
# or
uvicorn app:app --reload --port 8000
```

API will be available at `http://localhost:8000`

Interactive docs: `http://localhost:8000/docs`

## Deployment

### Docker

```bash
docker build -t opencv-validator .
docker run -p 8000:8000 opencv-validator
```

### Railway

1. Create new project on Railway
2. Connect GitHub repository
3. Set root directory to `opencv-validator`
4. Railway will auto-detect Dockerfile and deploy

**Environment Variables (optional):**
- `PORT`: Railway sets this automatically (default: 8000)

## Algorithm Details

### Line Detection Parameters

- **Canny Edge Detection**:
  - Lower threshold: 60
  - Upper threshold: 150
  - Aperture: 3x3

- **Hough Line Transform**:
  - Rho resolution: 1 pixel
  - Theta resolution: 1° (π/180 radians)
  - Threshold: 60 votes
  - Min line length: 80 pixels
  - Max line gap: 10 pixels

### Line Classification

- **Vertical lines**: 80° ≤ |angle| ≤ 100° (walls, door frames, window frames)
- **Horizontal lines**: |angle| ≤ 10° or |angle| ≥ 170° (ceiling, floor, countertops)

### Scoring Model

```
verticalShift = |avgVerticalEnhanced - avgVerticalOriginal|
horizontalShift = |avgHorizontalEnhanced - avgHorizontalOriginal|
deviationScore = verticalShift + horizontalShift
```

**Thresholds:**
- `deviationScore > 5°`: Suspicious (default)
- `deviationScore > 8°`: Recommended for blocking

## Testing

```bash
# Test with sample images
curl -X POST http://localhost:8000/validate-structure \
  -H "Content-Type: application/json" \
  -d '{
    "originalUrl": "https://example.com/original.jpg",
    "enhancedUrl": "https://example.com/enhanced.jpg"
  }'
```

## Performance

- Average processing time: 200-500ms per image pair
- Supports images up to 4K resolution
- Automatic image resizing for faster processing (optional)

## License

Part of RealEnhance v2.0 - Internal use only
