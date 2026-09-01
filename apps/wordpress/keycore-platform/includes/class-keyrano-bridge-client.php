<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

final class Bridge_Client implements Bridge
{
    private string $base_url;
    private string $origin;
    private string $secret;

    public function __construct()
    {
        $this->base_url = rtrim((string) getenv('KEYRANO_STAGING_BRIDGE_URL'), '/');
        $this->origin = rtrim((string) getenv('KEYRANO_STAGING_ORIGIN'), '/');
        $this->secret = (string) getenv('KEYRANO_STAGING_BRIDGE_SECRET');
    }

    /** @return array<string, mixed>|null */
    public function catalog(): ?array
    {
        return $this->request('GET', '/v1/catalog');
    }

    /** @param array<string, int|string> $command @return array<string, mixed>|null */
    public function checkout(int $wp_user_id, string $customer_id, array $command): ?array
    {
        return $this->request('POST', '/v1/checkout', $wp_user_id, $customer_id, true, $command);
    }

    /** @return array<string, mixed>|null */
    public function orders(int $wp_user_id, string $customer_id): ?array
    {
        return $this->request('GET', '/v1/account/orders', $wp_user_id, $customer_id);
    }

    /** @return array<string, mixed>|null */
    public function order(int $wp_user_id, string $customer_id, string $order_id): ?array
    {
        if (! self::is_uuid($order_id)) {
            return null;
        }
        return $this->request('GET', '/v1/account/orders/' . rawurlencode($order_id), $wp_user_id, $customer_id);
    }

    /** @return array<string, mixed>|null */
    public function invoice(int $wp_user_id, string $customer_id, string $order_id): ?array
    {
        if (! self::is_uuid($order_id)) {
            return null;
        }
        return $this->request(
            'POST',
            '/v1/account/orders/' . rawurlencode($order_id) . '/invoice',
            $wp_user_id,
            $customer_id,
            true
        );
    }

    /** @return array<string, mixed>|null */
    public function reveal(int $wp_user_id, string $customer_id, string $order_id): ?array
    {
        if (! self::is_uuid($order_id)) {
            return null;
        }
        return $this->request(
            'POST',
            '/v1/account/orders/' . rawurlencode($order_id) . '/reveal',
            $wp_user_id,
            $customer_id,
            true
        );
    }

    /** @return array<string, mixed>|null */
    public function claim(int $wp_user_id, string $customer_id, string $claim_code): ?array
    {
        if (
            strlen($claim_code) < 16 ||
            strlen($claim_code) > 128 ||
            1 !== preg_match('/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/', $claim_code)
        ) {
            return null;
        }
        return $this->request(
            'POST',
            '/v1/account/claim',
            $wp_user_id,
            $customer_id,
            true,
            ['claimCode' => $claim_code]
        );
    }

    /** @return array<string, mixed>|null */
    private function request(
        string $method,
        string $path,
        ?int $wp_user_id = null,
        ?string $customer_id = null,
        bool $csrf_verified = false,
        array $payload = []
    ): ?array {
        if (
            '' === $this->base_url ||
            '' === $this->origin ||
            strlen($this->secret) < 32 ||
            (null !== $customer_id && ! self::is_uuid($customer_id))
        ) {
            return null;
        }
        $body = [] === $payload
            ? ''
            : json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (! is_string($body)) {
            return null;
        }
        $timestamp = gmdate('c');
        $canonical = implode("\n", [
            $timestamp,
            $method,
            $path,
            $this->origin,
            null === $wp_user_id ? '' : (string) $wp_user_id,
            $customer_id ?? '',
            $csrf_verified ? '1' : '0',
            hash('sha256', $body),
        ]);
        $request_signature = self::base64url(hash_hmac('sha256', $canonical, $this->secret, true));
        $headers = [
            'Accept' => 'application/json',
            'X-KeyRaNo-Timestamp' => $timestamp,
            'X-KeyRaNo-Signature' => $request_signature,
            'X-KeyRaNo-Origin' => $this->origin,
            'X-KeyRaNo-CSRF-Verified' => $csrf_verified ? '1' : '0',
        ];
        if (null !== $wp_user_id) {
            $headers['X-KeyRaNo-WP-User-ID'] = (string) $wp_user_id;
        }
        if (null !== $customer_id) {
            $headers['X-KeyRaNo-Customer-ID'] = $customer_id;
        }
        $response = wp_remote_request($this->base_url . $path, [
            'body' => $body,
            'headers' => $headers,
            'method' => $method,
            'redirection' => 0,
            'timeout' => 5,
        ]);
        if (is_wp_error($response)) {
            return null;
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        $response_body = (string) wp_remote_retrieve_body($response);
        if (strlen($response_body) > 700000) {
            return null;
        }
        $response_timestamp = (string) wp_remote_retrieve_header($response, 'x-keyrano-response-timestamp');
        $response_signature = (string) wp_remote_retrieve_header($response, 'x-keyrano-response-signature');
        $response_time = strtotime($response_timestamp);
        $expected = self::base64url(hash_hmac(
            'sha256',
            $response_timestamp . "\n" . $status . "\n" . $request_signature . "\n" . hash('sha256', $response_body),
            $this->secret,
            true
        ));
        if (
            false === $response_time ||
            abs(time() - $response_time) > 60 ||
            ! hash_equals($expected, $response_signature)
        ) {
            return null;
        }
        $decoded = json_decode($response_body, true, 32, JSON_INVALID_UTF8_SUBSTITUTE);
        if (! is_array($decoded)) {
            return null;
        }
        $decoded['_httpStatus'] = $status;
        return $decoded;
    }

    private static function base64url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function is_uuid(string $value): bool
    {
        return 1 === preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value);
    }
}
