<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

abstract class Checkout_Gateway extends \WC_Payment_Gateway
{
    final public function __construct()
    {
        $this->id = static::gateway_id();
        $this->method_title = static::gateway_title();
        $this->method_description = __('Ausschließlich synthetische KeyRaNo-Staging-Zahlung.', 'keycore-platform');
        $this->title = static::gateway_title();
        $this->description = static::gateway_description();
        $this->enabled = 'yes';
        $this->has_fields = false;
        $this->supports = ['products'];
        add_action('woocommerce_thankyou_' . $this->id, [$this, 'thankyou_page']);
    }

    abstract public static function gateway_id(): string;

    abstract public static function gateway_title(): string;

    abstract public static function gateway_description(): string;

    abstract protected static function outcome(): string;

    public function is_available(): bool
    {
        return
            'staging' === wp_get_environment_type() &&
            parent::is_available();
    }

    /** @return array{result:string,redirect?:string} */
    public function process_payment($order_id): array
    {
        $order = wc_get_order((int) $order_id);
        $identity = self::current_identity();
        $is_guest = $order instanceof \WC_Order && ! is_user_logged_in() && 0 === $order->get_customer_id();
        if (
            ! $order instanceof \WC_Order ||
            (! $is_guest && (null === $identity || $order->get_customer_id() !== $identity['wpUserId']))
        ) {
            return $this->failed(__('Der sichere Staging-Checkout ist nicht verfügbar.', 'keycore-platform'));
        }
        $command = $this->command($order, $is_guest);
        if (null === $command) {
            return $this->failed(__('Der Warenkorb kann nicht sicher verarbeitet werden.', 'keycore-platform'));
        }
        $payload = (new Bridge_Client())->checkout(
            $identity['wpUserId'] ?? null,
            $identity['customerId'] ?? null,
            $command
        );
        $status = is_array($payload) ? (string) ($payload['status'] ?? '') : '';
        $keycore_order_id = is_array($payload) ? (string) ($payload['orderId'] ?? '') : '';

        if (
            in_array($status, ['CAPTURED', 'IDEMPOTENT'], true) &&
            self::is_uuid($keycore_order_id)
        ) {
            $order->update_meta_data('_keyrano_keycore_order_id', $keycore_order_id);
            $order->update_meta_data('_keyrano_checkout_status', 'CAPTURED');
            $order->update_meta_data(
                '_keyrano_guest_claim_delivery',
                $is_guest ? (string) ($payload['claimDeliveryStatus'] ?? 'UNAVAILABLE') : 'NOT_APPLICABLE'
            );
            $order->save();
            $order->payment_complete('keyrano-synthetic-staging');
            return [
                'redirect' => $this->get_return_url($order),
                'result' => 'success',
            ];
        }

        if ('FAILED' === $status || 'CANCELLED' === $status) {
            $order->update_meta_data('_keyrano_checkout_status', $status);
            $order->update_status(
                'FAILED' === $status ? 'failed' : 'cancelled',
                __('Synthetisches Staging-Zahlungsergebnis von KeyCore bestätigt.', 'keycore-platform')
            );
            $order->save();
            return [
                'redirect' => $this->get_return_url($order),
                'result' => 'success',
            ];
        }

        return $this->failed(__('Der sichere Staging-Checkout konnte nicht bestätigt werden.', 'keycore-platform'));
    }

    public function thankyou_page(int $order_id): void
    {
        $order = wc_get_order($order_id);
        if (! $order instanceof \WC_Order) {
            return;
        }
        $keycore_order_id = (string) $order->get_meta('_keyrano_keycore_order_id', true);
        $checkout_status = (string) $order->get_meta('_keyrano_checkout_status', true);
        if (in_array($checkout_status, ['FAILED', 'CANCELLED'], true)) {
            if (Plugin::terminal_result_was_rendered($order)) {
                return;
            }
            echo '<div class="keyrano-checkout-result keyrano-checkout-result-error">';
            echo '<h2>' . esc_html('FAILED' === $checkout_status ? __('Zahlung fehlgeschlagen', 'keycore-platform') : __('Zahlung abgebrochen', 'keycore-platform')) . '</h2>';
            echo '<p>' . esc_html__('Es wurde keine Bestellung erfüllt und kein Produktschlüssel bereitgestellt.', 'keycore-platform') . '</p>';
            echo '<p><a href="' . esc_url(wc_get_cart_url()) . '">' . esc_html__('Zurück zum Warenkorb', 'keycore-platform') . '</a></p>';
            echo '</div>';
            return;
        }
        if (! self::is_uuid($keycore_order_id)) {
            return;
        }
        if (0 === $order->get_customer_id()) {
            $delivery = (string) $order->get_meta('_keyrano_guest_claim_delivery', true);
            echo '<p class="keyrano-checkout-result">';
            echo esc_html__('Die synthetische Zahlung wurde bestätigt. Ein Produktschlüssel wird hier nicht angezeigt.', 'keycore-platform');
            echo ' ' . esc_html__('Für den Zugriff ist ein KeyRaNo-Konto mit exakt derselben E-Mail-Adresse wie beim Checkout erforderlich.', 'keycore-platform');
            echo ' ' . esc_html('ACCEPTED' === $delivery ? __('Der einmalige Kauf-Code wurde an die Staging-Mailbox gesendet.', 'keycore-platform') : __('Die Kauf-Code-Anleitung ist vorübergehend nicht verfügbar.', 'keycore-platform'));
            echo '</p>';
            return;
        }
        $url = wc_get_account_endpoint_url('kauf-details') . rawurlencode($keycore_order_id) . '/';
        echo '<p class="keyrano-checkout-result">';
        echo esc_html__('Die synthetische Zahlung wurde bestätigt. Der Kauf ist jetzt sicher deinem Konto zugeordnet.', 'keycore-platform');
        echo ' <a href="' . esc_url($url) . '">' . esc_html__('Kauf in „Meine Käufe“ öffnen', 'keycore-platform') . '</a>';
        echo '</p>';
    }

    /** @return array<string, int|string>|null */
    private function command(\WC_Order $order, bool $is_guest): ?array
    {
        $items = array_values($order->get_items('line_item'));
        if (1 !== count($items)) {
            return null;
        }
        $item = $items[0];
        if (! $item instanceof \WC_Order_Item_Product || 1 !== (int) $item->get_quantity()) {
            return null;
        }
        $product = $item->get_product();
        if (
            ! $product instanceof \WC_Product ||
            '1' !== $product->get_meta('_keyrano_managed', true)
        ) {
            return null;
        }
        $reference = sanitize_key((string) $product->get_meta('_keyrano_public_reference', true));
        $total_minor = self::minor_units((string) $order->get_total());
        $created_at = $order->get_date_created();
        if (
            '' === $reference ||
            null === $total_minor ||
            'EUR' !== $order->get_currency() ||
            ! $created_at instanceof \WC_DateTime
        ) {
            return null;
        }
        $command = [
            'checkoutCreatedAt' => gmdate('c', $created_at->getTimestamp()),
            'checkoutMode' => $is_guest ? 'GUEST' : 'ACCOUNT',
            'checkoutToken' => hash(
                'sha256',
                'keyrano-checkout-v1|' . $order->get_id() . '|' . $order->get_order_key()
            ),
            'currency' => 'EUR',
            'expectedTotalMinor' => $total_minor,
            'outcome' => static::outcome(),
            'productReference' => $reference,
            'quantity' => 1,
        ];
        if ($is_guest) {
            $email = strtolower(trim((string) $order->get_billing_email()));
            $configured = strtolower(trim((string) getenv('KEYRANO_STAGING_GUEST_CHECKOUT_EMAIL')));
            if ('' === $configured || $email !== $configured || 1 !== preg_match('/^[a-z0-9.!#$%&\'*+\/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)*example\.test$/', $email)) {
                return null;
            }
            $command['checkoutEmailNormalized'] = $email;
        }
        return $command;
    }

    /** @return array{result:string} */
    private function failed(string $message): array
    {
        wc_add_notice($message, 'error');
        return ['result' => 'failure'];
    }

    /** @return array{wpUserId:int,customerId:string}|null */
    private static function current_identity(): ?array
    {
        $wp_user_id = get_current_user_id();
        $customer_id = (string) get_user_meta($wp_user_id, '_keyrano_customer_id', true);
        return $wp_user_id > 0 && self::is_uuid($customer_id)
            ? ['customerId' => $customer_id, 'wpUserId' => $wp_user_id]
            : null;
    }

    private static function minor_units(string $amount): ?string
    {
        $normalized = wc_format_decimal($amount, 2);
        if (1 !== preg_match('/^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/', $normalized)) {
            return null;
        }
        [$whole, $fraction] = explode('.', $normalized, 2);
        return ltrim($whole . $fraction, '0') ?: '0';
    }

    private static function is_uuid(string $value): bool
    {
        return 1 === preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value);
    }
}

final class Checkout_Gateway_Success extends Checkout_Gateway
{
    public static function gateway_id(): string { return 'keyrano_synthetic_success'; }
    public static function gateway_title(): string { return __('Synthetische Zahlung (Erfolg)', 'keycore-platform'); }
    public static function gateway_description(): string { return __('Simuliert ausschließlich im Staging eine bestätigte Zahlung.', 'keycore-platform'); }
    protected static function outcome(): string { return 'SUCCESS'; }
}

final class Checkout_Gateway_Failure extends Checkout_Gateway
{
    public static function gateway_id(): string { return 'keyrano_synthetic_failure'; }
    public static function gateway_title(): string { return __('Synthetische Zahlung (Fehler)', 'keycore-platform'); }
    public static function gateway_description(): string { return __('Simuliert ausschließlich im Staging eine fehlgeschlagene Zahlung.', 'keycore-platform'); }
    protected static function outcome(): string { return 'FAILURE'; }
}

final class Checkout_Gateway_Cancel extends Checkout_Gateway
{
    public static function gateway_id(): string { return 'keyrano_synthetic_cancel'; }
    public static function gateway_title(): string { return __('Synthetische Zahlung (Abbruch)', 'keycore-platform'); }
    public static function gateway_description(): string { return __('Simuliert ausschließlich im Staging einen Zahlungsabbruch.', 'keycore-platform'); }
    protected static function outcome(): string { return 'CANCEL'; }
}

final class Checkout_Registration
{
    /** @param array<int, class-string> $gateways @return array<int, class-string> */
    public static function gateways(array $gateways): array
    {
        return 'staging' === wp_get_environment_type()
            ? array_merge($gateways, self::gateway_classes())
            : $gateways;
    }

    /** @return array<int, class-string<Checkout_Gateway>> */
    public static function gateway_classes(): array
    {
        return [
            Checkout_Gateway_Success::class,
            Checkout_Gateway_Failure::class,
            Checkout_Gateway_Cancel::class,
        ];
    }
}
