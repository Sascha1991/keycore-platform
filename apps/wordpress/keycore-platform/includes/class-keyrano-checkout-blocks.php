<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class Checkout_Blocks_Integration extends AbstractPaymentMethodType
{
    /** @param class-string<Checkout_Gateway> $gateway_class */
    public function __construct(private string $gateway_class)
    {
        $this->name = $gateway_class::gateway_id();
    }

    public function initialize(): void
    {
        $this->settings = [];
    }

    public function is_active(): bool
    {
        return 'staging' === wp_get_environment_type();
    }

    /** @return array<int, string> */
    public function get_payment_method_script_handles(): array
    {
        $handle = 'keyrano-staging-checkout-blocks';
        if (! wp_script_is($handle, 'registered')) {
            wp_register_script(
                $handle,
                plugins_url('assets/keyrano-checkout-blocks.js', KEYRANO_PLUGIN_FILE),
                ['wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'],
                KEYCORE_PLATFORM_VERSION,
                true
            );
        }
        return [$handle];
    }

    /** @return array<string, mixed> */
    public function get_payment_method_data(): array
    {
        return [
            'description' => $this->gateway_class::gateway_description(),
            'supports' => ['products'],
            'title' => $this->gateway_class::gateway_title(),
        ];
    }
}

final class Checkout_Blocks_Registration
{
    public static function blocks_loaded(): void
    {
        add_action(
            'woocommerce_blocks_payment_method_type_registration',
            static function ($registry): void {
                foreach (Checkout_Registration::gateway_classes() as $gateway_class) {
                    $registry->register(new Checkout_Blocks_Integration($gateway_class));
                }
            }
        );
    }

}
