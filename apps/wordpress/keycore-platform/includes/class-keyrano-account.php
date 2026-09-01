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

    public function handle_claim(): void
    {
        if (! is_user_logged_in()) {
            auth_redirect();
            exit;
        }
        $claim_code = isset($_POST['claim_code'])
            ? sanitize_text_field(wp_unslash((string) $_POST['claim_code']))
            : '';
        $nonce = isset($_POST['_wpnonce'])
            ? sanitize_text_field(wp_unslash((string) $_POST['_wpnonce']))
            : '';
        if (! wp_verify_nonce($nonce, 'keyrano_claim_purchase') || ! $this->same_origin()) {
            $this->render_claim_response('ACCESS_DENIED', 403);
        }
        if (
            strlen($claim_code) < 16 ||
            strlen($claim_code) > 128 ||
            1 !== preg_match('/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/', $claim_code)
        ) {
            $this->render_claim_response('CLAIM_INVALID', 400);
        }
        $identity = $this->identity();
        $payload = null === $identity
            ? null
            : $this->bridge->claim(
                $identity['wpUserId'],
                $identity['customerId'],
                $claim_code
            );
        $status = is_array($payload) ? (int) ($payload['_httpStatus'] ?? 503) : 503;
        $result = 200 === $status && 'CLAIMED' === ($payload['status'] ?? null)
            ? 'CLAIMED'
            : (503 === $status ? 'TEMPORARILY_UNAVAILABLE' : 'CLAIM_INVALID');
        $this->render_claim_response($result, $status);
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

    public function handle_invoice(): void
    {
        if (! is_user_logged_in()) {
            auth_redirect();
            exit;
        }
        if (! Invoice_Document_Response::has_exact_request_fields($_POST)) {
            $this->render_invoice_failure(400);
        }
        $order_id = isset($_POST['order_id']) ? sanitize_text_field(wp_unslash((string) $_POST['order_id'])) : '';
        $nonce = isset($_POST['_wpnonce']) ? sanitize_text_field(wp_unslash((string) $_POST['_wpnonce'])) : '';
        if (! wp_verify_nonce($nonce, 'keyrano_invoice_' . $order_id) || ! $this->same_origin()) {
            $this->render_invoice_failure(403);
        }
        $identity = $this->identity();
        $payload = null === $identity ? null : $this->bridge->invoice(
            $identity['wpUserId'],
            $identity['customerId'],
            $order_id
        );
        $bytes = Invoice_Document_Response::decode($payload);
        if (null === $bytes) {
            $status = 503 === (int) ($payload['_httpStatus'] ?? 0) ? 503 : 404;
            $this->render_invoice_failure($status);
        }
        status_header(200);
        foreach (Invoice_Document_Response::headers(strlen($bytes)) as $name => $value) {
            header($name . ': ' . $value, true);
        }
        echo $bytes;
        exit;
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

    private function render_claim_response(string $result, int $status): never
    {
        nocache_headers();
        header('Cache-Control: no-store, no-cache, must-revalidate, private', true);
        header('Pragma: no-cache', true);
        header('Referrer-Policy: no-referrer', true);
        status_header($status);
        require KEYRANO_PLUGIN_DIR . '/templates/account-claim-result.php';
        exit;
    }

    private function render_invoice_failure(int $status): never
    {
        nocache_headers();
        header('Cache-Control: no-store, no-cache, must-revalidate, private', true);
        header('Pragma: no-cache', true);
        header('Referrer-Policy: no-referrer', true);
        header('X-Content-Type-Options: nosniff', true);
        status_header($status);
        require KEYRANO_PLUGIN_DIR . '/templates/account-invoice-unavailable.php';
        exit;
    }
}
