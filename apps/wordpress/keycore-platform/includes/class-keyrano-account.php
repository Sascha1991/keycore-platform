<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

final class Account
{
    public function __construct(private Bridge $bridge)
    {
    }

    public function register_endpoints(): void
    {
        add_rewrite_endpoint('meine-kaeufe', EP_ROOT | EP_PAGES);
        add_rewrite_endpoint('kauf-details', EP_ROOT | EP_PAGES);
        add_rewrite_endpoint('kauf-hinzufuegen', EP_ROOT | EP_PAGES);
    }

    /** @param array<string, string> $items @return array<string, string> */
    public function menu_items(array $items): array
    {
        $logout = $items['customer-logout'] ?? null;
        unset($items['customer-logout']);
        $items['meine-kaeufe'] = __('Meine Käufe', 'keycore-platform');
        $items['kauf-hinzufuegen'] = __('Kauf hinzufügen', 'keycore-platform');
        if (null !== $logout) {
            $items['customer-logout'] = $logout;
        }
        return $items;
    }

    public function render_orders(): void
    {
        $identity = $this->identity();
        $payload = null === $identity ? null : $this->bridge->orders($identity['wpUserId'], $identity['customerId']);
        $orders = is_array($payload['orders'] ?? null) ? $payload['orders'] : [];
        $unavailable = null === $identity || 'OK' !== ($payload['status'] ?? null);
        require KEYRANO_PLUGIN_DIR . '/templates/account-orders.php';
    }

    public function render_order_detail(string $order_id = ''): void
    {
        $identity = $this->identity();
        $payload = null === $identity ? null : $this->bridge->order(
            $identity['wpUserId'],
            $identity['customerId'],
            sanitize_text_field($order_id)
        );
        $order = is_array($payload['order'] ?? null) ? $payload['order'] : null;
        require KEYRANO_PLUGIN_DIR . '/templates/account-order-detail.php';
    }

    public function render_claim_shell(): void
    {
        require KEYRANO_PLUGIN_DIR . '/templates/account-claim.php';
    }

    public function handle_reveal(): void
    {
        if (! is_user_logged_in()) {
            auth_redirect();
            exit;
        }
        $order_id = isset($_POST['order_id']) ? sanitize_text_field(wp_unslash((string) $_POST['order_id'])) : '';
        $nonce = isset($_POST['_wpnonce']) ? sanitize_text_field(wp_unslash((string) $_POST['_wpnonce'])) : '';
        if (! wp_verify_nonce($nonce, 'keyrano_reveal_' . $order_id) || ! $this->same_origin()) {
            $this->render_reveal_response(null, 403);
        }
        $identity = $this->identity();
        $payload = null === $identity ? null : $this->bridge->reveal(
            $identity['wpUserId'],
            $identity['customerId'],
            $order_id
        );
        $status = is_array($payload) ? (int) ($payload['_httpStatus'] ?? 503) : 503;
        $this->render_reveal_response($payload, $status);
    }

    /** @return array{wpUserId:int,customerId:string}|null */
    private function identity(): ?array
    {
        if (! is_user_logged_in()) {
            return null;
        }
        $wp_user_id = get_current_user_id();
        $customer_id = (string) get_user_meta($wp_user_id, '_keyrano_customer_id', true);
        if (1 !== preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $customer_id)) {
            return null;
        }
        return ['customerId' => $customer_id, 'wpUserId' => $wp_user_id];
    }

    private function same_origin(): bool
    {
        $raw = isset($_SERVER['HTTP_ORIGIN']) ? esc_url_raw(wp_unslash((string) $_SERVER['HTTP_ORIGIN'])) : '';
        if ('' === $raw) {
            return false;
        }
        return strtolower(rtrim($raw, '/')) === strtolower(rtrim(home_url(), '/'));
    }

    /** @param array<string, mixed>|null $payload */
    private function render_reveal_response(?array $payload, int $status): never
    {
        nocache_headers();
        header('Cache-Control: no-store, no-cache, must-revalidate, private', true);
        header('Pragma: no-cache', true);
        header('Referrer-Policy: no-referrer', true);
        status_header($status);
        $revealed_value = 200 === $status && 'REVEALED' === ($payload['status'] ?? null)
            ? (string) ($payload['value'] ?? '')
            : '';
        require KEYRANO_PLUGIN_DIR . '/templates/account-reveal.php';
        exit;
    }
}
