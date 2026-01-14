#!/bin/bash
# Verification script for RealEnhance production deployment

echo "========================================="
echo "RealEnhance Deployment Verification"
echo "========================================="
echo ""

# Check DNS resolution
echo "1. Checking DNS for api.realenhance.co.nz..."
nslookup api.realenhance.co.nz
echo ""

# Check if custom domain responds
echo "2. Checking if api.realenhance.co.nz responds..."
curl -I https://api.realenhance.co.nz/health 2>/dev/null | head -n 1
echo ""

# Check if www.realenhance.co.nz responds
echo "3. Checking if www.realenhance.co.nz responds..."
curl -I https://www.realenhance.co.nz 2>/dev/null | head -n 1
echo ""

# Check CORS headers
echo "4. Checking CORS configuration..."
curl -I -X OPTIONS https://api.realenhance.co.nz/api/auth-user \
  -H "Origin: https://www.realenhance.co.nz" \
  -H "Access-Control-Request-Method: GET" \
  2>/dev/null | grep -i "access-control"
echo ""

echo "========================================="
echo "Manual Verification Steps:"
echo "========================================="
echo "1. Open browser DevTools → Network tab"
echo "2. Go to https://www.realenhance.co.nz"
echo "3. Login with Google"
echo "4. Check /api/auth-user request:"
echo "   - Should go to: api.realenhance.co.nz"
echo "   - Should have: Cookie: realsess=..."
echo "   - Should return: 200 OK (not 401)"
echo ""
