#!/usr/bin/env sh
set -eu

wp plugin install woocommerce --version=11.0.0 --activate --path=/var/www/html
