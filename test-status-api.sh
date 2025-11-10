#!/bin/bash
# Quick test script to check if job status is returning URLs

echo "Testing job status endpoint..."
echo ""

JOB_ID="job_f1d77e76-8e45-4ee9-8333-fe6ee281e7aa"
SERVER="https://server-production-96f7.up.railway.app"

echo "1. Testing /api/health/s3..."
curl -s "$SERVER/api/health/s3" | python3 -m json.tool
echo ""

echo "2. Testing /api/health..."
curl -s "$SERVER/api/health" | python3 -m json.tool
echo ""

echo "3. Job status (will fail due to auth, but shows endpoint exists)..."
curl -s "$SERVER/api/status/$JOB_ID" | python3 -m json.tool || echo "Auth required"
echo ""

echo "4. Batch status..."
curl -s "$SERVER/api/status/batch?ids=$JOB_ID" | python3 -m json.tool || echo "Auth required"
echo ""

echo "Done. If you see auth errors, the server is deployed correctly."
echo "The issue is likely client-side polling or display logic."
