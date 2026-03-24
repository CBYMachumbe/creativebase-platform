# CreativeBase — AWS Infrastructure (CB-002)
# terraform init && terraform plan && terraform apply

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket = "creativebase-terraform-state"
    key    = "infra/terraform.tfstate"
    region = "af-south-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
}

# ── VPC ─────────────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  name    = "creativebase-${var.environment}"
  cidr    = "10.0.0.0/16"
  azs             = ["${var.aws_region}a", "${var.aws_region}b"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]
  enable_nat_gateway   = true
  single_nat_gateway   = var.environment != "production"
  enable_dns_hostnames = true
}

# ── RDS PostgreSQL (Multi-AZ in production) ──────────────────────────────
resource "aws_db_instance" "postgres" {
  identifier              = "creativebase-${var.environment}"
  engine                  = "postgres"
  engine_version          = "16.2"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  max_allocated_storage   = 100
  storage_encrypted       = true
  db_name                 = "creativebase"
  username                = var.db_username
  password                = var.db_password
  multi_az                = var.environment == "production"
  publicly_accessible     = false
  deletion_protection     = var.environment == "production"
  skip_final_snapshot     = var.environment != "production"
  backup_retention_period = 30
  backup_window           = "02:00-03:00"
  maintenance_window      = "sun:04:00-sun:05:00"
  vpc_security_group_ids  = [aws_security_group.rds.id]
  db_subnet_group_name    = aws_db_subnet_group.main.name
  tags = local.common_tags
}

resource "aws_db_subnet_group" "main" {
  name       = "creativebase-${var.environment}"
  subnet_ids = module.vpc.private_subnets
  tags       = local.common_tags
}

# ── ElastiCache Redis ────────────────────────────────────────────────────
resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "creativebase-${var.environment}"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  tags                 = local.common_tags
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "creativebase-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

# ── S3 Buckets ───────────────────────────────────────────────────────────
resource "aws_s3_bucket" "uploads" {
  bucket = "creativebase-uploads-${var.environment}-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket" "private" {
  bucket = "creativebase-private-${var.environment}-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "private" {
  bucket                  = aws_s3_bucket.private.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── CloudFront CDN ───────────────────────────────────────────────────────
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  default_root_object = "index.html"
  origin {
    domain_name = aws_s3_bucket.uploads.bucket_regional_domain_name
    origin_id   = "s3-uploads"
    s3_origin_config { origin_access_identity = aws_cloudfront_origin_access_identity.oai.cloudfront_access_identity_path }
  }
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-uploads"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
    forwarded_values { query_string = false; cookies { forward = "none" } }
  }
  restrictions { geo_restriction { restriction_type = "none" } }
  viewer_certificate { cloudfront_default_certificate = true }
  tags = local.common_tags
}

resource "aws_cloudfront_origin_access_identity" "oai" {
  comment = "CreativeBase CDN OAI"
}

# ── Security Groups ──────────────────────────────────────────────────────
resource "aws_security_group" "rds" {
  name   = "creativebase-rds-${var.environment}"
  vpc_id = module.vpc.vpc_id
  ingress { from_port = 5432; to_port = 5432; protocol = "tcp"; cidr_blocks = module.vpc.private_subnets_cidr_blocks }
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
  tags   = local.common_tags
}

resource "aws_security_group" "redis" {
  name   = "creativebase-redis-${var.environment}"
  vpc_id = module.vpc.vpc_id
  ingress { from_port = 6379; to_port = 6379; protocol = "tcp"; cidr_blocks = module.vpc.private_subnets_cidr_blocks }
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
  tags   = local.common_tags
}

data "aws_caller_identity" "current" {}

locals {
  common_tags = {
    Project     = "creativebase"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}