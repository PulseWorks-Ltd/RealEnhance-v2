#!/bin/bash
# Test script to verify API response structure
# Usage: ./test-api-response.sh <JOB_ID>

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <JOB_ID>"
  echo "Example: $0 job-1731321234567-abc123"
  exit 1
fi

JOB_ID="$1"
API_URL="${API_URL:-http://localhost:5000}"

echo "=========================================="
echo "Testing API Response Structure"
echo "=========================================="
echo "Job ID: $JOB_ID"
echo "API URL: $API_URL"
echo ""

# Test single job endpoint
echo "1. Testing /api/status/$JOB_ID"
echo "------------------------------------------"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -H "Cookie: connect.sid=test" \
  -H "Cache-Control: no-cache" \
  "$API_URL/api/status/$JOB_ID")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d':' -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')

echo "HTTP Status: $HTTP_STATUS"
echo ""
echo "Response Body:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

# Check for key fields
if echo "$BODY" | jq -e '.imageUrl' > /dev/null 2>&1; then
  IMAGE_URL=$(echo "$BODY" | jq -r '.imageUrl')
  echo "✅ imageUrl field present: ${IMAGE_URL:0:80}..."
else
  echo "❌ imageUrl field MISSING"
fi

if echo "$BODY" | jq -e '.resultUrl' > /dev/null 2>&1; then
  RESULT_URL=$(echo "$BODY" | jq -r '.resultUrl')
  echo "✅ resultUrl field present: ${RESULT_URL:0:80}..."
else
  echo "❌ resultUrl field MISSING"
fi

if echo "$BODY" | jq -e '.stageUrls' > /dev/null 2>&1; then
  echo "✅ stageUrls field present"
  echo "$BODY" | jq '.stageUrls' 2>/dev/null
else
  echo "❌ stageUrls field MISSING"
fi

echo ""

# Test batch endpoint
echo "2. Testing /api/status/batch?ids=$JOB_ID"
echo "------------------------------------------"
BATCH_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -H "Cookie: connect.sid=test" \
  -H "Cache-Control: no-cache" \
  "$API_URL/api/status/batch?ids=$JOB_ID")

BATCH_HTTP_STATUS=$(echo "$BATCH_RESPONSE" | grep "HTTP_STATUS:" | cut -d':' -f2)
BATCH_BODY=$(echo "$BATCH_RESPONSE" | sed '/HTTP_STATUS:/d')

echo "HTTP Status: $BATCH_HTTP_STATUS"
echo ""
echo "Response Body:"
echo "$BATCH_BODY" | jq '.' 2>/dev/null || echo "$BATCH_BODY"
echo ""

# Check batch response structure
if echo "$BATCH_BODY" | jq -e '.items[0].imageUrl' > /dev/null 2>&1; then
  BATCH_IMAGE_URL=$(echo "$BATCH_BODY" | jq -r '.items[0].imageUrl')
  echo "✅ items[0].imageUrl present: ${BATCH_IMAGE_URL:0:80}..."
else
  echo "❌ items[0].imageUrl MISSING"
fi

echo ""

# Test S3 URL accessibility (if found)
if [ ! -z "$IMAGE_URL" ] && [[ "$IMAGE_URL" == https://* ]]; then
  echo "3. Testing S3 URL accessibility"
  echo "------------------------------------------"
  echo "URL: ${IMAGE_URL:0:100}..."
  echo ""
  
  # Test HEAD request (faster than GET)
  if curl -sI "$IMAGE_URL" | head -1 | grep -q "200"; then
    echo "✅ S3 URL accessible (HTTP 200)"
    
    # Check CORS headers
    echo ""
    echo "CORS Headers:"
    curl -sI -H "Origin: http://localhost:5173" "$IMAGE_URL" | grep -i "access-control" || echo "❌ No CORS headers found"
  else
    echo "❌ S3 URL not accessible"
    curl -sI "$IMAGE_URL" | head -3
  fi
fi

echo ""
echo "=========================================="
echo "Test complete"
echo "=========================================="
