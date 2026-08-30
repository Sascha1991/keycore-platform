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
        add_action('wp_enqueue_scripts', [self::class, 'assets']);
        add_action('wp_body_open', [self::class, 'brand_bar']);
        add_action('woocommerce_before_shop_loop', [self::class, 'shop_intro'], 5);
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
        wp_enqueue_style(
            'keyrano-storefront',
            plugins_url('assets/keyrano.css', KEYRANO_PLUGIN_FILE),
            [],
            KEYCORE_PLATFORM_VERSION
        );
    }

    public static function brand_bar(): void
    {
        echo '<header class="keyrano-brand"><a class="keyrano-brand__name" href="' . esc_url(home_url('/')) . '">KeyRaNo</a>';
        echo '<span class="keyrano-brand__claim">' . esc_html__('Dein Key. Direkt. Ohne Warten.', 'keycore-platform') . '</span>';
        echo '<nav aria-label="' . esc_attr__('KeyRaNo Navigation', 'keycore-platform') . '">';
        echo '<a href="' . esc_url(wc_get_page_permalink('shop')) . '">' . esc_html__('Produkte', 'keycore-platform') . '</a>';
        echo '<a href="' . esc_url(wc_get_cart_url()) . '">' . esc_html__('Warenkorb', 'keycore-platform') . '</a>';
        echo '<a href="' . esc_url(wc_get_page_permalink('myaccount')) . '">' . esc_html__('Mein Konto', 'keycore-platform') . '</a></nav></header>';
    }

    public static function shop_intro(): void
    {
        echo '<div class="keyrano-shop-intro"><p class="keyrano-kicker">Key · Rapid Access · No Waiting</p>';
        echo '<h1>' . esc_html__('Digitale Games. Klar ausgewählt.', 'keycore-platform') . '</h1>';
        echo '<p>' . esc_html__('Nur für Deutschland freigegebene, verfügbare Angebote werden angezeigt.', 'keycore-platform') . '</p></div>';
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
