<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account">
<?php if (! is_array($order)) : ?>
    <div class="keyrano-state keyrano-state--error"><?php echo esc_html__('Dieser Kauf ist nicht verfügbar.', 'keycore-platform'); ?></div>
<?php else : ?>
    <p class="keyrano-kicker"><?php echo esc_html__('Kaufdetails', 'keycore-platform'); ?></p>
    <h2><?php echo esc_html((string) ($order['productTitle'] ?? __('Digitales Produkt', 'keycore-platform'))); ?></h2>
    <dl class="keyrano-detail-grid">
        <div><dt><?php echo esc_html__('Status', 'keycore-platform'); ?></dt><dd><?php echo esc_html(\KeyRaNo\Storefront\Plugin::status_label((string) ($order['status'] ?? 'PENDING'))); ?></dd></div>
        <div><dt><?php echo esc_html__('Zahlung', 'keycore-platform'); ?></dt><dd><?php echo esc_html(\KeyRaNo\Storefront\Plugin::status_label((string) ($order['paymentStatus'] ?? 'PENDING'))); ?></dd></div>
        <div><dt><?php echo esc_html__('Rechnung', 'keycore-platform'); ?></dt><dd><?php echo esc_html(\KeyRaNo\Storefront\Plugin::status_label((string) ($order['invoice']['status'] ?? 'NOT_AVAILABLE'))); ?></dd></div>
        <div><dt><?php echo esc_html__('Aktivierung', 'keycore-platform'); ?></dt><dd><?php echo esc_html((string) ($order['activationInstructions']['instructionCode'] ?? __('Noch nicht verfügbar', 'keycore-platform'))); ?></dd></div>
    </dl>
    <?php if ('AVAILABLE' === ($order['invoice']['status'] ?? null) && true === ($order['invoice']['downloadAvailable'] ?? false)) : ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="keyrano-invoice-form">
            <input type="hidden" name="action" value="keyrano_invoice">
            <input type="hidden" name="order_id" value="<?php echo esc_attr((string) $order['orderId']); ?>">
            <?php wp_nonce_field('keyrano_invoice_' . (string) $order['orderId'], '_wpnonce', false, true); ?>
            <button type="submit" class="button"><?php echo esc_html__('Rechnung herunterladen', 'keycore-platform'); ?></button>
        </form>
    <?php endif; ?>
    <?php if (true === ($order['fulfillment']['keyAccessAvailable'] ?? false)) : ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="keyrano-reveal-form">
            <input type="hidden" name="action" value="keyrano_reveal">
            <input type="hidden" name="order_id" value="<?php echo esc_attr((string) $order['orderId']); ?>">
            <?php wp_nonce_field('keyrano_reveal_' . (string) $order['orderId']); ?>
            <button type="submit" class="button alt"><?php echo esc_html__('Key anzeigen', 'keycore-platform'); ?></button>
        </form>
    <?php else : ?>
        <div class="keyrano-state"><?php echo esc_html__('Dein Key ist noch nicht verfügbar.', 'keycore-platform'); ?></div>
    <?php endif; ?>
<?php endif; ?>
</section>
