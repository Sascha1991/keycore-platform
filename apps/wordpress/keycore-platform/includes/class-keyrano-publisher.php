<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

final class Publisher
{
    public function __construct(private Bridge $bridge)
    {
    }

    public function maybe_sync(): void
    {
        if ('staging' !== wp_get_environment_type() || false !== get_transient('keyrano_catalog_synced')) {
            return;
        }
        if ($this->sync()) {
            set_transient('keyrano_catalog_synced', '1', HOUR_IN_SECONDS);
        }
    }

    public function sync(): bool
    {
        if (! class_exists('WC_Product_Simple')) {
            return false;
        }
        $payload = $this->bridge->catalog();
        if (! is_array($payload) || 'OK' !== ($payload['status'] ?? null) || ! is_array($payload['products'] ?? null)) {
            return false;
        }
        $seen = [];
        foreach ($payload['products'] as $source) {
            if (! is_array($source) || ! $this->is_safe_product($source)) {
                continue;
            }
            $reference = sanitize_key((string) $source['publicReference']);
            $seen[] = $reference;
            $sku = 'keyrano-' . $reference;
            $existing_id = (int) wc_get_product_id_by_sku($sku);
            $product = $existing_id > 0 ? wc_get_product($existing_id) : new \WC_Product_Simple();
            if (! $product instanceof \WC_Product) {
                continue;
            }
            $product->set_name(sanitize_text_field((string) $source['title']));
            $product->set_sku($sku);
            $product->set_regular_price(number_format(((int) $source['priceMinor']) / 100, 2, '.', ''));
            $product->set_status('publish');
            $product->set_catalog_visibility('visible');
            $product->set_stock_status('instock');
            $product->set_virtual(true);
            $product->set_description(wp_kses_post((string) $source['description']));
            $product->update_meta_data('_keyrano_managed', '1');
            $product->update_meta_data('_keyrano_public_reference', $reference);
            $product->update_meta_data('_keyrano_platform', sanitize_text_field((string) $source['platform']));
            $product->update_meta_data('_keyrano_region', sanitize_text_field((string) $source['region']));
            $product->update_meta_data('_keyrano_activation', sanitize_text_field((string) $source['activation']));
            $product->save();
        }
        $managed = wc_get_products([
            'limit' => -1,
            'meta_key' => '_keyrano_managed',
            'meta_value' => '1',
            'return' => 'objects',
            'status' => ['publish', 'draft', 'private'],
        ]);
        foreach ($managed as $product) {
            if (! $product instanceof \WC_Product) {
                continue;
            }
            $reference = (string) $product->get_meta('_keyrano_public_reference', true);
            if (! in_array($reference, $seen, true)) {
                $product->set_status('draft');
                $product->set_catalog_visibility('hidden');
                $product->set_stock_status('outofstock');
                $product->save();
            }
        }
        return true;
    }

    /** @param array<string, mixed> $source */
    private function is_safe_product(array $source): bool
    {
        $required = ['publicReference', 'title', 'platform', 'region', 'activation', 'description', 'priceMinor', 'currency', 'publicationStatus'];
        foreach ($required as $field) {
            if (! array_key_exists($field, $source)) {
                return false;
            }
        }
        return
            is_string($source['publicReference']) &&
            '' !== sanitize_key($source['publicReference']) &&
            is_string($source['title']) &&
            'EUR' === $source['currency'] &&
            'PUBLISHABLE' === $source['publicationStatus'] &&
            is_int($source['priceMinor']) &&
            $source['priceMinor'] > 0;
    }
}
