output "cdn_domain"        { value = aws_cloudfront_distribution.cdn.domain_name }
output "rds_endpoint"      { value = aws_db_instance.postgres.endpoint }
output "redis_endpoint"    { value = aws_elasticache_cluster.redis.cache_nodes[0].address }
output "uploads_bucket"    { value = aws_s3_bucket.uploads.id }
output "private_bucket"    { value = aws_s3_bucket.private.id }