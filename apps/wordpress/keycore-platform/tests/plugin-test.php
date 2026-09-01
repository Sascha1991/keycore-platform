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
$GLOBALS['keyrano_nonce_fields'] = [];

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
function admin_url(string $path = ''): string { return '/wp-admin/' . $path; }
function esc_url(string $value): string { return $value; }
function esc_html__(string $value, string $domain): string { return $value; }
function esc_attr__(string $value, string $domain): string { return $value; }
function esc_html(string $value): string { return htmlspecialchars($value, ENT_QUOTES); }
function esc_attr(string $value): string { return htmlspecialchars($value, ENT_QUOTES); }
function wc_get_page_permalink(string $page): string { return '/' . $page . '/'; }
function wc_get_cart_url(): string { return '/cart/'; }
function wc_get_account_endpoint_url(string $endpoint): string { return '/my-account/' . ('' === $endpoint || 'dashboard' === $endpoint ? '' : $endpoint . '/'); }
function wp_date(string $format, int $timestamp): string { return gmdate($format, $timestamp); }
function wp_nonce_field(string $action, string $name = '_wpnonce', bool $referer = true, bool $display = true): string {
    $GLOBALS['keyrano_nonce_fields'][] = compact('action', 'name', 'referer', 'display');
    $field = '<input type="hidden" name="' . esc_attr($name) . '" value="synthetic-nonce">';
    if ($display) { echo $field; }
    return $field;
}
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
    public function invoice(int $wp_user_id, string $customer_id, string $order_id): ?array { return null; }
    public function reveal(int $wp_user_id, string $customer_id, string $order_id): ?array { return null; }
    public function claim(int $wp_user_id, string $customer_id, string $claim_code): ?array { return ['status' => 'CLAIMED']; }
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

/** @param array<string, mixed> $fixture */
function render_order_detail(array $fixture): string
{
    $order = $fixture;
    ob_start();
    require dirname(__DIR__) . '/templates/account-order-detail.php';
    return (string) ob_get_clean();
}

/** @param array<int, array<string, mixed>> $fixtures */
function render_orders(array $fixtures, bool $is_unavailable = false): string
{
    $orders = $fixtures;
    $unavailable = $is_unavailable;
    ob_start();
    require dirname(__DIR__) . '/templates/account-orders.php';
    return (string) ob_get_clean();
}

function render_template(string $template): string
{
    ob_start();
    require dirname(__DIR__) . '/templates/' . $template;
    return (string) ob_get_clean();
}

foreach (['init', 'woocommerce_account_meine-kaeufe_endpoint', 'woocommerce_account_kauf-details_endpoint', 'woocommerce_account_kauf-hinzufuegen_endpoint', 'woocommerce_before_edit_account_form', 'woocommerce_edit_account_form_start', 'admin_post_keyrano_reveal', 'admin_post_keyrano_claim_purchase', 'admin_post_keyrano_invoice', 'admin_post_nopriv_keyrano_invoice', 'woocommerce_blocks_loaded'] as $hook) {
    assert_true(in_array($hook, $GLOBALS['keyrano_test_actions'], true), 'Missing hook: ' . $hook);
}
assert_true(in_array('woocommerce_account_menu_items', $GLOBALS['keyrano_test_filters'], true), 'Missing account menu filter');
assert_true(in_array('woocommerce_payment_gateways', $GLOBALS['keyrano_test_filters'], true), 'Synthetic staging gateways are not registered');
$account = new \KeyRaNo\Storefront\Account(new FakeBridge());
ob_start();
$account->render_claim_shell();
$claim_form = (string) ob_get_clean();
assert_true(false !== strpos($claim_form, 'type="password"'), 'Guest claim code is not protected as a password input');
assert_true(false !== strpos($claim_form, 'keyrano_claim_purchase'), 'Guest claim form is not CSRF-bound');
assert_true(false === stripos($claim_form, 'Bestellnummer'), 'Guest claim form exposes an unnecessary order identifier');
assert_true('Bezahlt' === \KeyRaNo\Storefront\Plugin::status_label('CAPTURED'), 'Captured status was not localized');
assert_true('In Bearbeitung' === \KeyRaNo\Storefront\Plugin::status_label('FULFILLMENT_PENDING'), 'Fulfillment status was not presented safely');
assert_true('Ausstehend' === \KeyRaNo\Storefront\Plugin::status_label('PENDING'), 'Pending order status was not localized');
assert_true('Abgeschlossen' === \KeyRaNo\Storefront\Plugin::status_label('COMPLETED'), 'Completed order status was not localized');
assert_true('Aktion erforderlich' === \KeyRaNo\Storefront\Plugin::status_label('ACTION_REQUIRED'), 'Action-required order status was not localized');
assert_true('Storniert' === \KeyRaNo\Storefront\Plugin::status_label('CANCELLED'), 'Cancelled order status was not localized');
assert_true('Erstattet' === \KeyRaNo\Storefront\Plugin::status_label('REFUNDED'), 'Refunded order status was not localized');
assert_true('Ausstehend' === \KeyRaNo\Storefront\Plugin::invoice_status_label('PENDING'), 'Pending invoice status was not localized');
assert_true('Fehlgeschlagen' === \KeyRaNo\Storefront\Plugin::invoice_status_label('FAILED'), 'Failed invoice status was not localized');
assert_true('danger' === \KeyRaNo\Storefront\Plugin::status_tone('FAILED'), 'Failed status did not receive a safe warning tone');
assert_true('18,99 €' === \KeyRaNo\Storefront\Plugin::money_label('1899', 'EUR'), 'Minor-unit total was not formatted for the German storefront');
assert_true('Nicht verfügbar' === \KeyRaNo\Storefront\Plugin::money_label('invalid', 'EUR'), 'Malformed amount did not fail closed in presentation');
assert_true('In Bearbeitung' === \KeyRaNo\Storefront\Plugin::status_label('UNKNOWN_INTERNAL_STATE'), 'Unknown status did not use a safe customer label');
$orders_html = render_orders([
    [
        'createdAt' => '2026-08-30T12:00:00.000Z',
        'currency' => 'EUR',
        'fulfillmentAvailable' => true,
        'orderId' => '20000000-0000-4000-8000-000000000001',
        'productKey' => 'TEST-OVERVIEW-MUST-NOT-LEAK',
        'productTitle' => 'Neonpfad: Berlin',
        'status' => 'READY',
        'totalMinor' => '1299',
    ],
    [
        'createdAt' => '2026-08-31T12:00:00.000Z',
        'currency' => 'EUR',
        'fulfillmentAvailable' => false,
        'orderId' => '20000000-0000-4000-8000-000000000002',
        'productTitle' => 'Arena Eleven',
        'status' => 'FULFILLMENT_PENDING',
        'totalMinor' => '2199',
    ],
]);
assert_true(false !== strpos($orders_html, 'Alle deine Käufe auf einen Blick.'), 'Purchase overview heading is absent');
assert_true(false !== strpos($orders_html, '12,99 €'), 'Purchase total is absent');
assert_true(false !== strpos($orders_html, 'Bereit'), 'Ready purchase status is absent');
assert_true(false !== strpos($orders_html, 'In Bearbeitung'), 'Pending purchase status is absent');
assert_true(false !== strpos($orders_html, 'Key verfügbar'), 'Safe key availability badge is absent');
assert_true(false !== strpos($orders_html, 'Details ansehen'), 'Purchase detail action is absent');
assert_true(false === strpos($orders_html, 'TEST-OVERVIEW-MUST-NOT-LEAK'), 'Product Key leaked into purchase overview HTML');
$empty_orders_html = render_orders([]);
assert_true(false !== strpos($empty_orders_html, 'Sobald du etwas kaufst, erscheint es hier.'), 'Purchase empty state is incomplete');
$unavailable_orders_html = render_orders([], true);
assert_true(false !== strpos($unavailable_orders_html, 'Bitte versuche es später erneut.'), 'Purchase unavailable state is incomplete');
$claim_html = render_template('account-claim.php');
assert_true(false !== strpos($claim_html, '<form'), 'Active claim form is absent');
assert_true(false !== strpos($claim_html, 'type="password"'), 'Claim code is not protected as a password input');
assert_true(false !== strpos($claim_html, 'keyrano_claim_purchase'), 'Claim form is not bound to the secure action');
assert_true(false === strpos($claim_html, 'disabled'), 'Active claim controls remain disabled');
assert_true(false === stripos($claim_html, 'Bestellnummer'), 'Claim form requests an unnecessary order identifier');
$details_header_html = render_template('account-details-header.php');
assert_true(false !== strpos($details_header_html, 'Verwalte deine persönlichen Daten und deinen Login.'), 'Account details presentation header is absent');
$base_order_detail = [
    'createdAt' => '2026-08-30T12:00:00.000Z',
    'currency' => 'EUR',
    'fulfillment' => ['keyAccessAvailable' => false],
    'invoice' => ['downloadAvailable' => false, 'status' => 'PENDING'],
    'orderId' => '20000000-0000-4000-8000-000000000001',
    'productKey' => 'TEST-AAAAA-BBBBB-CCCCC',
    'productTitle' => 'Orbital Tactics',
    'status' => 'FULFILLMENT_PENDING',
    'totalMinor' => '1899',
];
$pending_detail = render_order_detail($base_order_detail);
assert_true(false !== strpos($pending_detail, '30.08.2026'), 'German order date is absent from purchase detail');
assert_true(false !== strpos($pending_detail, '18,99 €'), 'German total is absent from purchase detail');
assert_true(false !== strpos($pending_detail, 'Die Rechnung wird erstellt, sobald deine Bestellung abgeschlossen ist.'), 'Pending invoice guidance is absent');
assert_true(false === strpos($pending_detail, 'value="keyrano_invoice"'), 'Pending invoice rendered an active download path');
assert_true(false === strpos($pending_detail, 'TEST-AAAAA-BBBBB-CCCCC'), 'Product Key leaked into initial purchase HTML');
$GLOBALS['keyrano_nonce_fields'] = [];
$available_detail = render_order_detail(array_replace_recursive($base_order_detail, [
    'fulfillment' => ['keyAccessAvailable' => true],
    'invoice' => ['downloadAvailable' => true, 'status' => 'AVAILABLE'],
]));
assert_true(false !== strpos($available_detail, 'value="keyrano_invoice"'), 'Available invoice secure form is absent');
assert_true(false !== strpos($available_detail, 'value="keyrano_reveal"'), 'Existing reveal form is absent');
assert_true(false !== strpos($available_detail, 'name="_wpnonce"'), 'Secure action nonce is absent from rendered HTML');
assert_true(false === strpos($available_detail, 'TEST-AAAAA-BBBBB-CCCCC'), 'Product Key leaked from available purchase HTML');
$invoice_nonce = array_values(array_filter(
    $GLOBALS['keyrano_nonce_fields'],
    static fn (array $field): bool => str_starts_with($field['action'], 'keyrano_invoice_')
));
assert_true(1 === count($invoice_nonce), 'Invoice form did not render exactly one dedicated nonce');
assert_true(false === $invoice_nonce[0]['referer'] && true === $invoice_nonce[0]['display'], 'Invoice nonce rendering contract changed');
$pdf = "%PDF-1.4\nsynthetic invoice\n%%EOF\n";
$invoice_payload = [
    '_httpStatus' => 200,
    'document' => ['body' => base64_encode($pdf), 'contentType' => 'application/pdf', 'encoding' => 'base64'],
    'status' => 'AVAILABLE',
];
assert_true($pdf === \KeyRaNo\Storefront\Invoice_Document_Response::decode($invoice_payload), 'Valid signed bridge invoice payload was not decoded');
assert_true(null === \KeyRaNo\Storefront\Invoice_Document_Response::decode(array_merge($invoice_payload, ['filename' => "bad\r\nInjected: yes"])), 'Unexpected invoice response fields were accepted');
$wrong_type = $invoice_payload;
$wrong_type['document']['contentType'] = 'text/html';
assert_true(null === \KeyRaNo\Storefront\Invoice_Document_Response::decode($wrong_type), 'Non-PDF invoice content type was accepted');
$bad_pdf = $invoice_payload;
$bad_pdf['document']['body'] = base64_encode("%PDF-1.4\nmissing trailer");
assert_true(null === \KeyRaNo\Storefront\Invoice_Document_Response::decode($bad_pdf), 'Malformed PDF framing was accepted');
$oversized_pdf = $invoice_payload;
$oversized_pdf['document']['body'] = str_repeat('A', 700001);
assert_true(null === \KeyRaNo\Storefront\Invoice_Document_Response::decode($oversized_pdf), 'Oversized invoice envelope was accepted');
assert_true(
    \KeyRaNo\Storefront\Invoice_Document_Response::has_exact_request_fields(['_wpnonce' => 'nonce', 'action' => 'keyrano_invoice', 'order_id' => '20000000-0000-4000-8000-000000000001']),
    'Exact invoice action fields were rejected'
);
assert_true(
    ! \KeyRaNo\Storefront\Invoice_Document_Response::has_exact_request_fields(['_wpnonce' => 'nonce', 'action' => 'keyrano_invoice', 'invoiceId' => '../private', 'order_id' => '20000000-0000-4000-8000-000000000001']),
    'Unexpected invoice authority fields were accepted'
);
$invoice_headers = \KeyRaNo\Storefront\Invoice_Document_Response::headers(strlen($pdf));
assert_true('attachment; filename="keyrano-rechnung.pdf"' === ($invoice_headers['Content-Disposition'] ?? null), 'Invoice filename is not fixed and safe');
assert_true(false !== strpos((string) ($invoice_headers['Cache-Control'] ?? ''), 'no-store'), 'Invoice response is cacheable');
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
$first = wc_get_product(wc_get_product_id_by_sku('keyrano-safe-one'));
assert_true(
    'Safe staging description' === ($first?->state()['data']['description'] ?? null),
    'Initial owned description field was not published'
);
$bridge->products[0]['description'] = 'Updated staging description';
assert_true($publisher->sync(), 'Repeated publisher sync failed');
assert_true(2 === count($GLOBALS['keyrano_products']), 'Repeated sync created duplicates');
$first = wc_get_product(wc_get_product_id_by_sku('keyrano-safe-one'));
assert_true(
    'Updated staging description' === ($first?->state()['data']['description'] ?? null),
    'Owned description field was not updated'
);

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
