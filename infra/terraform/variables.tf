# CreativeBase Terraform Variables
variable "aws_region"        { default = "af-south-1" }
variable "environment"       { default = "staging" }
variable "db_instance_class" { default = "db.t3.micro" }
variable "db_username"       { sensitive = true }
variable "db_password"       { sensitive = true }