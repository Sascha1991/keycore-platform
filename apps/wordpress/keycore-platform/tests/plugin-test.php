<?php

declare(strict_types=1);

define('ABSPATH', __DIR__ . '/');
define('HOUR_IN_SECONDS', 3600);
define('EP_ROOT', 1);
define('EP_PAGES', 2);

$GLOBALS['keyrano_test_actions'] = [];
$GLOBALS['keyrano_test_filters'] = [];
$GLOBALS['keyrano_products'] = [];
$GLOBALS['keyrano_order'] = null;
$GLOBALS['keyrano_notices'] = [];

function add_action(string $name, mixed $callback, int $priority = 10): void { $GLOBALS['keyrano_test_actions'][] = $name; }
function add_filter(string $name, mixed $callback): void { $GLOBALS['keyrano_test_filters'][] = $name; }
function register_activation_hook(string $file, mixed $callback): void { $GLOBALS['keyrano_test_actions'][] = 'activation'; }
function sanitize_key(string $value): string { return trim(strtolower(preg_replace('/[^a-z0-9_-]/', '', $value) ?? '')); }
function sanitize_text_field(string $value): string { return trim(strip_tags($value)); }
function wp_kses_post(string $value): string { return strip_tags($value, '<p><strong><em>'); }
function wp_get_environment_type(): string { return 'staging'; }
function get_transient(string $name): false { return false; }
function set_transient(string $name, string $value, int $ttl): bool { return true; }
function __(string $value, string $domain): string { return $value; }
function plugins_url(string $path, string $file): string { return '/plugins/keycore-platform/' . $path; }
function wp_enqueue_style(string $handle, string $src, array $deps, string $version): void {}
function home_url(string $path = ''): string { return 'https://staging.keyrano.de' . $path; }
function esc_url(string $value): string { return $value; }
function esc_html__(string $value, string $domain): string { return $value; }
function esc_attr__(string $value, string $domain): string { return $value; }
function esc_html(string $value): string { return htmlspecialchars($value, ENT_QUOTES); }
function wc_get_page_permalink(string $page): string { return '/' . $page . '/'; }
function wc_get_cart_url(): string { return '/cart/'; }
function flush_rewrite_rules(): void {}
function add_rewrite_endpoint(string $name, int $places): void {}
function wc_print_notice(string $message, string $type): void {}
function is_user_logged_in(): bool { return true; }
function get_current_user_id(): int { return 20; }
function get_user_meta(int $user_id, string $key, bool $single = true): string { return '10000000-0000-4000-8000-000000000001'; }
function wc_get_order(int $order_id): mixed { return $GLOBALS['keyrano_order']; }
function wc_add_notice(string $message, string $type): void { $GLOBALS['keyrano_notices'][] = [$message, $type]; }

class WC_Payment_Gateway
{
    public string $id = '';
    public string $method_title = '';
    public string $method_description = '';
    public string $title = '';
    public string $description = '';
    public string $enabled = 'no';
    public bool $has_fields = false;
    public array $supports = [];
    public function is_available(): bool { return 'yes' === $this->enabled; }
    public function get_return_url(mixed $order): string { return '/order-received/'; }
}

class WC_Order
{
    public function __construct(private int $customer_id) {}
    public function get_customer_id(): int { return $this->customer_id; }
}

class WC_Product
{
    protected int $id = 0;
    protected array $data = [];
    protected array $meta = [];
    public function set_name(string $value): void { $this->data['name'] = $value; }
    public function set_sku(string $value): void { $this->data['sku'] = $value; }
    public function set_regular_price(string $value): void { $this->data['price'] = $value; }
    public function set_status(string $value): void { $this->data['status'] = $value; }
    public function set_catalog_visibility(string $value): void { $this->data['visibility'] = $value; }
    public function set_stock_status(string $value): void { $this->data['stock'] = $value; }
    public function set_virtual(bool $value): void { $this->data['virtual'] = $value; }
    public function set_description(string $value): void { $this->data['description'] = $value; }
    public function update_meta_data(string $key, string $value): void { $this->meta[$key] = $value; }
    public function get_meta(string $key, bool $single = true): string { return (string) ($this->meta[$key] ?? ''); }
    public function save(): int {
        if (0 === $this->id) { $this->id = count($GLOBALS['keyrano_products']) + 1; }
        $GLOBALS['keyrano_products'][$this->id] = $this;
        return $this->id;
    }
    public function state(): array { return ['data' => $this->data, 'meta' => $this->meta]; }
}
class WC_Product_Simple extends WC_Product {}

function wc_get_product_id_by_sku(string $sku): int {
    foreach ($GLOBALS['keyrano_products'] as $id => $product) {
        if (($product->state()['data']['sku'] ?? null) === $sku) return (int) $id;
    }
    return 0;
}
function wc_get_product(int $id): ?WC_Product { return $GLOBALS['keyrano_products'][$id] ?? null; }
function wc_get_products(array $query): array { return array_values($GLOBALS['keyrano_products']); }

require dirname(__DIR__) . '/keycore-platform.php';

use KeyRaNo\Storefront\Bridge;
use KeyRaNo\Storefront\Publisher;

final class FakeBridge implements Bridge
{
    public array $products;
    public function __construct() { $this->products = [fixture('safe-one'), fixture('safe-two')]; }
    public function catalog(): ?array { return ['products' => $this->products, 'status' => 'OK']; }
    public function checkout(int $wp_user_id, string $customer_id, array $command): ?array { return null; }
    public function orders(int $wp_user_id, string $customer_id): ?array { return null; }
    public function order(int $wp_user_id, string $customer_id, string $order_id): ?array { return null; }
    public function reveal(int $wp_user_id, string $customer_id, string $order_id): ?array { return null; }
}

function fixture(string $reference): array
{
    return [
        'activation' => 'Steam',
        'currency' => 'EUR',
        'description' => 'Safe staging description',
        'platform' => 'PC',
        'priceMinor' => 1299,
        'publicationStatus' => 'PUBLISHABLE',
        'publicReference' => $reference,
        'region' => 'Deutschland',
        'title' => 'Synthetic ' . $reference,
    ];
}

function assert_true(bool $condition, string $message): void
{
    if (! $condition) { fwrite(STDERR, $message . PHP_EOL); exit(1); }
}

foreach (['init', 'woocommerce_account_meine-kaeufe_endpoint', 'woocommerce_account_kauf-details_endpoint', 'admin_post_keyrano_reveal', 'woocommerce_blocks_loaded'] as $hook) {
    assert_true(in_array($hook, $GLOBALS['keyrano_test_actions'], true), 'Missing hook: ' . $hook);
}
assert_true(in_array('woocommerce_account_menu_items', $GLOBALS['keyrano_test_filters'], true), 'Missing account menu filter');
assert_true(in_array('woocommerce_payment_gateways', $GLOBALS['keyrano_test_filters'], true), 'Synthetic staging gateways are not registered');
assert_true('Bezahlt' === \KeyRaNo\Storefront\Plugin::status_label('CAPTURED'), 'Captured status was not localized');
assert_true('In Bearbeitung' === \KeyRaNo\Storefront\Plugin::status_label('UNKNOWN_INTERNAL_STATE'), 'Unknown status did not use a safe customer label');
$gateways = \KeyRaNo\Storefront\Checkout_Registration_Loader::gateways([]);
assert_true(3 === count($gateways), 'Expected three explicit synthetic checkout outcomes');
$success_gateway = new \KeyRaNo\Storefront\Checkout_Gateway_Success();
assert_true($success_gateway->is_available(), 'Synthetic success gateway is unavailable in staging');
$GLOBALS['keyrano_order'] = new WC_Order(21);
assert_true(
    ['result' => 'failure'] === $success_gateway->process_payment(100),
    'A checkout for another WordPress customer was not denied'
);
assert_true(1 === count($GLOBALS['keyrano_notices']), 'Cross-customer checkout denial did not produce a safe notice');

$bridge = new FakeBridge();
$publisher = new Publisher($bridge);
assert_true($publisher->sync(), 'Initial publisher sync failed');
assert_true(2 === count($GLOBALS['keyrano_products']), 'Create did not publish exactly two products');
assert_true($publisher->sync(), 'Repeated publisher sync failed');
assert_true(2 === count($GLOBALS['keyrano_products']), 'Repeated sync created duplicates');

$bridge->products[0]['priceMinor'] = 1599;
$bridge->products[1]['publicationStatus'] = 'BLOCKED';
assert_true($publisher->sync(), 'Update publisher sync failed');
$first = wc_get_product(wc_get_product_id_by_sku('keyrano-safe-one'));
$second = wc_get_product(wc_get_product_id_by_sku('keyrano-safe-two'));
assert_true('15.99' === ($first?->state()['data']['price'] ?? null), 'Owned price field was not updated');
assert_true('draft' === ($second?->state()['data']['status'] ?? null), 'Removed or blocked product was not unpublished');
assert_true('hidden' === ($second?->state()['data']['visibility'] ?? null), 'Unpublished product remained visible');

$serialized = serialize($GLOBALS['keyrano_products']);
assert_true(false === stripos($serialized, 'supplier'), 'Supplier data leaked into WooCommerce product state');
echo "KeyRaNo WordPress adapter tests passed\n";
