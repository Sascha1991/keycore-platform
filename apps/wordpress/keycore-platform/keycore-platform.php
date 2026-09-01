<?php
/**
 * Plugin Name: KeyCore Platform
 * Description: KeyRaNo storefront presentation adapter for WooCommerce.
 * Version: 1.0.2
 * Requires PHP: 8.3
 * Requires Plugins: woocommerce
 * Author: KeyCore
 */

declare(strict_types=1);

if (! defined('ABSPATH')) {
    exit;
}

define('KEYCORE_PLATFORM_VERSION', '1.0.2');
define('KEYRANO_PLUGIN_FILE', __FILE__);
define('KEYRANO_PLUGIN_DIR', __DIR__);

require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-bridge.php';
require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-bridge-client.php';
require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-invoice-document.php';
require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-publisher.php';
require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-account.php';
require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-plugin.php';

KeyRaNo\Storefront\Plugin::register();
