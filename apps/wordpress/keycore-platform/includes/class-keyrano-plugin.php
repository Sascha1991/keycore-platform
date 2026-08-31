<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

final class Plugin
{
    public static function register(): void
    {
        $bridge = new Bridge_Client();
        $account = new Account($bridge);
        $publisher = new Publisher($bridge);

        add_action('init', [$account, 'register_endpoints']);
        add_action('init', [$publisher, 'maybe_sync'], 20);
        add_filter('woocommerce_account_menu_items', [$account, 'menu_items']);
        add_action('woocommerce_account_meine-kaeufe_endpoint', [$account, 'render_orders']);
        add_action('woocommerce_account_kauf-details_endpoint', [$account, 'render_order_detail']);
        add_action('woocommerce_account_kauf-hinzufuegen_endpoint', [$account, 'render_claim_shell']);
        add_action('admin_post_keyrano_reveal', [$account, 'handle_reveal']);
        add_action('admin_post_nopriv_keyrano_reveal', [$account, 'handle_reveal']);
        add_filter('woocommerce_payment_gateways', [Checkout_Registration_Loader::class, 'gateways']);
        add_action('woocommerce_blocks_loaded', [Checkout_Registration_Loader::class, 'blocks_loaded']);
        add_action('wp_enqueue_scripts', [self::class, 'assets']);
        add_action('woocommerce_single_product_summary', [self::class, 'product_facts'], 25);
        add_action('woocommerce_before_checkout_form', [self::class, 'checkout_notice'], 5);
        register_activation_hook(KEYRANO_PLUGIN_FILE, [self::class, 'activate']);
    }

    public static function activate(): void
    {
        (new Account(new Bridge_Client()))->register_endpoints();
        flush_rewrite_rules();
    }

    public static function assets(): void
    {
        $asset_path = KEYRANO_PLUGIN_DIR . '/assets/keyrano.css';
        wp_enqueue_style(
            'keyrano-storefront',
            plugins_url('assets/keyrano.css', KEYRANO_PLUGIN_FILE),
            [],
            is_file($asset_path) ? (string) filemtime($asset_path) : KEYCORE_PLATFORM_VERSION
        );
    }

    public static function status_label(string $status): string
    {
        $labels = [
            'AVAILABLE' => __('Verfügbar', 'keycore-platform'),
            'CAPTURED' => __('Bezahlt', 'keycore-platform'),
            'DELIVERY_PENDING' => __('Lieferung wird vorbereitet', 'keycore-platform'),
            'FULFILLMENT_PENDING' => __('Key wird vorbereitet', 'keycore-platform'),
            'NOT_AVAILABLE' => __('Nicht verfügbar', 'keycore-platform'),
            'PAYMENT_CAPTURED' => __('Zahlung bestätigt', 'keycore-platform'),
            'PENDING' => __('In Bearbeitung', 'keycore-platform'),
            'PROCESSING' => __('In Bearbeitung', 'keycore-platform'),
            'READY' => __('Bereit', 'keycore-platform'),
            'RETRIEVED' => __('Sicher hinterlegt', 'keycore-platform'),
            'SUCCEEDED' => __('Abgeschlossen', 'keycore-platform'),
        ];

        return $labels[$status] ?? __('In Bearbeitung', 'keycore-platform');
    }

    public static function product_facts(): void
    {
        global $product;
        if (! $product instanceof \WC_Product || '1' !== $product->get_meta('_keyrano_managed', true)) {
            return;
        }
        $facts = [
            __('Plattform', 'keycore-platform') => $product->get_meta('_keyrano_platform', true),
            __('Region', 'keycore-platform') => $product->get_meta('_keyrano_region', true),
            __('Aktivierung', 'keycore-platform') => $product->get_meta('_keyrano_activation', true),
        ];
        echo '<dl class="keyrano-product-facts">';
        foreach ($facts as $label => $value) {
            echo '<div><dt>' . esc_html($label) . '</dt><dd>' . esc_html((string) $value) . '</dd></div>';
        }
        echo '</dl>';
    }

    public static function checkout_notice(): void
    {
        if ('staging' === wp_get_environment_type()) {
            wc_print_notice(
                __('Staging-Checkout: Es erfolgt keine Live-Zahlung und keine echte Lieferantenbestellung.', 'keycore-platform'),
                'notice'
            );
        }
    }
}

final class Checkout_Registration_Loader
{
    /** @param array<int, class-string> $gateways @return array<int, class-string> */
    public static function gateways(array $gateways): array
    {
        require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-checkout-gateway.php';
        return Checkout_Registration::gateways($gateways);
    }

    public static function blocks_loaded(): void
    {
        require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-checkout-gateway.php';
        require_once KEYRANO_PLUGIN_DIR . '/includes/class-keyrano-checkout-blocks.php';
        Checkout_Blocks_Registration::blocks_loaded();
    }
}
