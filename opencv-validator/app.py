"""
OpenCV-based Structural Validator Microservice for RealEnhance v2.0

This FastAPI service provides line-edge structural validation using OpenCV's
Hough Line Transform to detect architectural lines (walls, windows, doors)
and compare them between original and enhanced images.

Endpoints:
  POST /validate-structure - Validate structural integrity between two images
  GET /health - Health check endpoint
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import cv2
import numpy as np
import requests
import io
from typing import Dict, List, Optional
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="RealEnhance Structural Validator",
    description="OpenCV-based line-edge structural validation service",
    version="2.0.0"
)


class ValidationRequest(BaseModel):
    originalUrl: str
    enhancedUrl: str
    sensitivity: Optional[float] = 5.0  # Default deviation threshold


class LineSummary(BaseModel):
    count: int
    verticalCount: int
    horizontalCount: int
    verticalAngles: List[float]
    horizontalAngles: List[float]
    avgVerticalAngle: float
    avgHorizontalAngle: float


class ValidationResponse(BaseModel):
    original: LineSummary
    enhanced: LineSummary
    verticalShift: float
    horizontalShift: float
    deviationScore: float
    isSuspicious: bool
    message: str


def download_image(url: str) -> np.ndarray:
    """
    Download image from URL and decode to OpenCV format.

    Args:
        url: HTTP(S) URL to image

    Returns:
        NumPy array in BGR format (OpenCV standard)

    Raises:
        HTTPException if download fails
    """
    try:
        logger.info(f"Downloading image from: {url[:80]}...")
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()

        img_array = np.frombuffer(resp.content, np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

        if img is None:
            raise ValueError("Failed to decode image")

        logger.info(f"Downloaded image: {img.shape}")
        return img

    except Exception as e:
        logger.error(f"Failed to download image: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to download image: {str(e)}")


def detect_lines(img: np.ndarray) -> np.ndarray:
    """
    Detect straight lines in image using Canny edge detection and Hough Line Transform.

    Optimized for real estate photography to detect:
    - Vertical lines (walls, window frames, door frames, wardrobes)
    - Horizontal lines (ceiling, floor, window sills, countertops)

    Args:
        img: BGR image from OpenCV

    Returns:
        Array of lines, shape (N, 4) where each line is [x1, y1, x2, y2]
    """
    # Resize large images to prevent memory issues and speed up processing
    max_dimension = 1920  # Max width or height
    h, w = img.shape[:2]
    if max(h, w) > max_dimension:
        scale = max_dimension / max(h, w)
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        logger.info(f"Resized image from {w}x{h} to {new_w}x{new_h} for processing")

    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Apply Gaussian blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Canny edge detection
    # Lower threshold = 60, Upper threshold = 150
    edges = cv2.Canny(blurred, 60, 150, apertureSize=3)

    # Hough Line Transform (Probabilistic)
    # Optimized parameters for architectural features:
    # - rho: 1 pixel resolution
    # - theta: 1 degree resolution (π/180 radians)
    # - threshold: 60 votes minimum
    # - minLineLength: 80 pixels (captures window frames, door frames)
    # - maxLineGap: 10 pixels (tolerates small gaps in edges)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=60,
        minLineLength=80,
        maxLineGap=10
    )

    if lines is None:
        logger.warning("No lines detected in image")
        return np.array([])

    # Reshape from (N, 1, 4) to (N, 4)
    lines = lines[:, 0, :]
    logger.info(f"Detected {len(lines)} lines")

    return lines


def classify_lines(lines: np.ndarray) -> LineSummary:
    """
    Classify detected lines into vertical and horizontal categories.

    Classification criteria:
    - Vertical lines: angle close to 90° (±10° tolerance)
    - Horizontal lines: angle close to 0° or 180° (±10° tolerance)

    Args:
        lines: Array of lines, shape (N, 4)

    Returns:
        LineSummary with classified lines and statistics
    """
    if len(lines) == 0:
        return LineSummary(
            count=0,
            verticalCount=0,
            horizontalCount=0,
            verticalAngles=[],
            horizontalAngles=[],
            avgVerticalAngle=0.0,
            avgHorizontalAngle=0.0
        )

    vertical_angles = []
    horizontal_angles = []

    for x1, y1, x2, y2 in lines:
        # Calculate angle in degrees
        # arctan2(dy, dx) gives angle from -180° to +180°
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))

        # Normalize to absolute angle (0-180°)
        abs_angle = abs(angle)

        # Vertical lines: 80° to 100° (centered on 90°)
        if 80 <= abs_angle <= 100:
            vertical_angles.append(angle)
        # Horizontal lines: 0° to 10° or 170° to 180°
        elif abs_angle <= 10 or abs_angle >= 170:
            horizontal_angles.append(angle)

    # Calculate averages
    avg_vertical = float(np.mean(vertical_angles)) if vertical_angles else 0.0
    avg_horizontal = float(np.mean(horizontal_angles)) if horizontal_angles else 0.0

    return LineSummary(
        count=len(lines),
        verticalCount=len(vertical_angles),
        horizontalCount=len(horizontal_angles),
        verticalAngles=[float(a) for a in vertical_angles],
        horizontalAngles=[float(a) for a in horizontal_angles],
        avgVerticalAngle=avg_vertical,
        avgHorizontalAngle=avg_horizontal
    )


@app.get("/")
def root():
    """Root endpoint - service info"""
    return {
        "service": "RealEnhance Structural Validator",
        "version": "2.0.0",
        "status": "running"
    }


@app.get("/health")
def health_check():
    """Health check endpoint for monitoring"""
    return {"status": "healthy"}


@app.post("/validate-structure", response_model=ValidationResponse)
def validate_structure(request: ValidationRequest) -> ValidationResponse:
    """
    Validate structural integrity between original and enhanced images.

    This endpoint:
    1. Downloads both images from provided URLs
    2. Detects architectural lines using Hough Line Transform
    3. Classifies lines as vertical (walls, doors) or horizontal (ceiling, floor)
    4. Compares line angles between original and enhanced
    5. Calculates structural deviation score
    6. Determines if deviation is suspicious

    Args:
        request: ValidationRequest with originalUrl and enhancedUrl

    Returns:
        ValidationResponse with detailed structural analysis
    """
    logger.info("=== Starting structural validation ===")

    try:
        # Download images
        logger.info(f"Downloading original image: {request.originalUrl[:100]}...")
        original_img = download_image(request.originalUrl)
        logger.info(f"✓ Original downloaded successfully: shape={original_img.shape}, size={original_img.nbytes} bytes")

        logger.info(f"Downloading enhanced image: {request.enhancedUrl[:100]}...")
        enhanced_img = download_image(request.enhancedUrl)
        logger.info(f"✓ Enhanced downloaded successfully: shape={enhanced_img.shape}, size={enhanced_img.nbytes} bytes")

        # Detect lines
        logger.info("Detecting lines in original image...")
        original_lines = detect_lines(original_img)
        logger.info(f"✓ Detected {len(original_lines)} lines in original")

        logger.info("Detecting lines in enhanced image...")
        enhanced_lines = detect_lines(enhanced_img)
        logger.info(f"✓ Detected {len(enhanced_lines)} lines in enhanced")

        # Classify lines
        original_summary = classify_lines(original_lines)
        enhanced_summary = classify_lines(enhanced_lines)

        # Calculate structural shifts
        # Vertical shift: change in average vertical line angle
        vertical_shift = abs(
            enhanced_summary.avgVerticalAngle - original_summary.avgVerticalAngle
        ) if original_summary.verticalCount > 0 and enhanced_summary.verticalCount > 0 else 0.0

        # Horizontal shift: change in average horizontal line angle
        horizontal_shift = abs(
            enhanced_summary.avgHorizontalAngle - original_summary.avgHorizontalAngle
        ) if original_summary.horizontalCount > 0 and enhanced_summary.horizontalCount > 0 else 0.0

        # Overall deviation score
        deviation_score = vertical_shift + horizontal_shift

        # Determine if suspicious based on sensitivity threshold
        is_suspicious = deviation_score > request.sensitivity

        # Generate message
        if is_suspicious:
            message = f"Structural consistency check failed (score: {deviation_score:.2f}°)"
        else:
            message = f"Structural validation passed: {deviation_score:.2f}° deviation"

        logger.info(f"Validation complete: deviation={deviation_score:.2f}°, suspicious={is_suspicious}")

        return ValidationResponse(
            original=original_summary,
            enhanced=enhanced_summary,
            verticalShift=round(vertical_shift, 3),
            horizontalShift=round(horizontal_shift, 3),
            deviationScore=round(deviation_score, 3),
            isSuspicious=is_suspicious,
            message=message
        )

    except Exception as e:
        logger.error(f"Validation failed: {e}", exc_info=True)
        # Return detailed error information
        import traceback
        error_detail = {
            "error": str(e),
            "type": type(e).__name__,
            "traceback": traceback.format_exc()
        }
        logger.error(f"Full error details: {error_detail}")
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
