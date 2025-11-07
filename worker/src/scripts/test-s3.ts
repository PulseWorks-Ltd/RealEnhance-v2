import { S3Client, PutObjectCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

async function testS3() {
  console.log('\n=== S3 Configuration Test ===\n');
  
  // Check environment variables
  console.log('Environment Check:');
  console.log('  S3_BUCKET:', process.env.S3_BUCKET || '❌ NOT SET');
  console.log('  AWS_REGION:', process.env.AWS_REGION || '❌ NOT SET (will default to us-east-1)');
  console.log('  AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `✓ Set (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : '❌ NOT SET');
  console.log('  AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '✓ Set (hidden)' : '❌ NOT SET');
  console.log('  S3_ACL:', process.env.S3_ACL || 'public-read (default)');
  console.log('  S3_PREFIX:', process.env.S3_PREFIX || 'realenhance/outputs (default)');
  console.log('  S3_PUBLIC_BASEURL:', process.env.S3_PUBLIC_BASEURL || '❌ NOT SET (will use S3 direct URL)');
  console.log('');
  
  if (!process.env.S3_BUCKET) {
    console.error('❌ S3_BUCKET not set. Cannot test S3.');
    process.exit(1);
  }
  
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS credentials not set. Cannot test S3.');
    process.exit(1);
  }
  
  // Test connection
  console.log('Testing S3 Connection...');
  const region = process.env.AWS_REGION || 'us-east-1';
  const clientConfig: any = {
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
    }
  };
  
  const s3 = new S3Client(clientConfig);
  
  try {
    console.log('  → Listing buckets...');
    const buckets = await s3.send(new ListBucketsCommand({}));
    console.log(`  ✓ Connected! Found ${buckets.Buckets?.length || 0} buckets`);
    if (buckets.Buckets) {
      buckets.Buckets.forEach(b => console.log(`    - ${b.Name}`));
    }
  } catch (e: any) {
    console.error('  ❌ Failed to list buckets:', e.message);
    console.error('  Error code:', e.Code || e.code);
    console.error('  Check your AWS credentials and permissions');
    process.exit(1);
  }
  
  // Test upload
  console.log('');
  console.log('Testing Upload...');
  const testKey = `test-${Date.now()}.txt`;
  const testContent = 'Test upload from RealEnhance worker';
  
  try {
    console.log(`  → Uploading to s3://${process.env.S3_BUCKET}/${testKey}`);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: testKey,
      Body: Buffer.from(testContent),
      ContentType: 'text/plain',
      ACL: process.env.S3_ACL as any || 'public-read'
    }));
    
    const base = process.env.S3_PUBLIC_BASEURL || '';
    const url = base 
      ? `${base}/${testKey}` 
      : `https://${process.env.S3_BUCKET}.s3.${region}.amazonaws.com/${testKey}`;
    
    console.log('  ✓ Upload successful!');
    console.log(`  URL: ${url}`);
    console.log('');
    console.log('✅ S3 is working correctly!');
    console.log('');
    console.log('Your worker should now upload enhanced images to S3.');
    console.log('Check Railway worker logs for "[publish] S3 upload successful" messages.');
  } catch (e: any) {
    console.error('  ❌ Upload failed:', e.message);
    console.error('  Error code:', e.Code || e.code);
    
    if (e.Code === 'NoSuchBucket') {
      console.error(`  → Bucket "${process.env.S3_BUCKET}" does not exist or you don't have access`);
    } else if (e.Code === 'AccessDenied') {
      console.error('  → Your AWS credentials don\'t have permission to upload to this bucket');
      console.error('  → Make sure the IAM user has s3:PutObject permission');
    }
    
    process.exit(1);
  }
}

testS3().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
