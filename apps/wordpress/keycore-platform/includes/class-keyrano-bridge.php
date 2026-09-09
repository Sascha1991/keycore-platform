<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

interface Bridge
{
    /** @return array<string, mixed>|null */
    public function catalog(): ?array;

    /** @param array<string, int|string> $command @return array<string, mixed>|null */
    public function checkout(?int $wp_user_id, ?string $customer_id, array $command): ?array;

    /** @return array<string, mixed>|null */
    public function orders(int $wp_user_id, string $customer_id): ?array;

    /** @return array<string, mixed>|null */
    public function order(int $wp_user_id, string $customer_id, string $order_id): ?array;

    /** @return array<string, mixed>|null */
    public function invoice(int $wp_user_id, string $customer_id, string $order_id): ?array;

    /** @return array<string, mixed>|null */
    public function reveal(int $wp_user_id, string $customer_id, string $order_id): ?array;

    /** @return array<string, mixed>|null */
    public function claim(int $wp_user_id, string $customer_id, string $claim_code): ?array;

    /** @return array<string, mixed>|null */
    public function support_cases(int $wp_user_id, string $customer_id): ?array;

    /** @return array<string, mixed>|null */
    public function support_case(int $wp_user_id, string $customer_id, string $case_id): ?array;

    /** @param array<string, string> $command @return array<string, mixed>|null */
    public function create_support_case(int $wp_user_id, string $customer_id, array $command): ?array;

    /** @return array<string, mixed>|null */
    public function reply_support_case(int $wp_user_id, string $customer_id, string $case_id, string $message): ?array;
}
