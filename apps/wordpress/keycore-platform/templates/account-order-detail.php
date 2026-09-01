<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account keyrano-account-surface keyrano-order-detail">
<?php if (! is_array($order)) : ?>
    <div class="keyrano-state keyrano-state--error"><?php echo esc_html__('Dieser Kauf ist nicht verfügbar.', 'keycore-platform'); ?></div>
<?php else : ?>
    <?php
    $product_title = (string) ($order['productTitle'] ?? __('Digitales Produkt', 'keycore-platform'));
    $order_status = (string) ($order['status'] ?? 'PENDING');
    $invoice_status = (string) ($order['invoice']['status'] ?? 'NOT_AVAILABLE');
    $created_at = strtotime((string) ($order['createdAt'] ?? ''));
    $order_date = false === $created_at ? __('Nicht verfügbar', 'keycore-platform') : wp_date('d.m.Y', $created_at);
    $total = \KeyRaNo\Storefront\Plugin::money_label(
        (string) ($order['totalMinor'] ?? ''),
        (string) ($order['currency'] ?? '')
    );
    ?>
    <nav class="keyrano-breadcrumbs" aria-label="<?php echo esc_attr__('Brotkrümelnavigation', 'keycore-platform'); ?>">
        <a href="<?php echo esc_url(wc_get_account_endpoint_url('dashboard')); ?>"><?php echo esc_html__('Mein Konto', 'keycore-platform'); ?></a>
        <span aria-hidden="true">›</span>
        <a href="<?php echo esc_url(wc_get_account_endpoint_url('meine-kaeufe')); ?>"><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></a>
        <span aria-hidden="true">›</span>
        <span aria-current="page"><?php echo esc_html($product_title); ?></span>
    </nav>
    <header class="keyrano-order-detail__header">
        <p class="keyrano-kicker"><?php echo esc_html__('Kaufdetails', 'keycore-platform'); ?></p>
        <h2><?php echo esc_html($product_title); ?></h2>
    </header>
    <dl class="keyrano-order-summary">
        <div>
            <dt><?php echo esc_html__('Bestellstatus', 'keycore-platform'); ?></dt>
            <dd><span class="keyrano-badge keyrano-badge--<?php echo esc_attr(\KeyRaNo\Storefront\Plugin::status_tone($order_status)); ?>"><?php echo esc_html(\KeyRaNo\Storefront\Plugin::status_label($order_status)); ?></span></dd>
        </div>
        <div>
            <dt><?php echo esc_html__('Bestelldatum', 'keycore-platform'); ?></dt>
            <dd><?php echo esc_html($order_date); ?></dd>
        </div>
        <div>
            <dt><?php echo esc_html__('Gesamtbetrag', 'keycore-platform'); ?></dt>
            <dd><?php echo esc_html($total); ?></dd>
        </div>
        <div>
            <dt><?php echo esc_html__('Rechnungsstatus', 'keycore-platform'); ?></dt>
            <dd><span class="keyrano-badge keyrano-badge--<?php echo esc_attr(\KeyRaNo\Storefront\Plugin::status_tone($invoice_status)); ?>"><?php echo esc_html(\KeyRaNo\Storefront\Plugin::invoice_status_label($invoice_status)); ?></span></dd>
        </div>
    </dl>
    <div class="keyrano-order-actions">
        <section class="keyrano-order-action" aria-labelledby="keyrano-key-heading">
            <p class="keyrano-order-action__label"><?php echo esc_html__('Produktschlüssel', 'keycore-platform'); ?></p>
            <?php if (true === ($order['fulfillment']['keyAccessAvailable'] ?? false)) : ?>
                <h3 id="keyrano-key-heading"><?php echo esc_html__('Sicher verfügbar', 'keycore-platform'); ?></h3>
                <p><?php echo esc_html__('Zeige deinen Produktschlüssel nur an einem sicheren Ort an.', 'keycore-platform'); ?></p>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="keyrano-reveal-form keyrano-action-form">
                    <input type="hidden" name="action" value="keyrano_reveal">
                    <input type="hidden" name="order_id" value="<?php echo esc_attr((string) $order['orderId']); ?>">
                    <?php wp_nonce_field('keyrano_reveal_' . (string) $order['orderId']); ?>
                    <button type="submit" class="button alt"><?php echo esc_html__('Key anzeigen', 'keycore-platform'); ?></button>
                </form>
            <?php else : ?>
                <h3 id="keyrano-key-heading"><?php echo esc_html__('Noch nicht verfügbar', 'keycore-platform'); ?></h3>
                <p><?php echo esc_html__('Der Produktschlüssel wird angezeigt, sobald deine Bestellung abgeschlossen ist.', 'keycore-platform'); ?></p>
            <?php endif; ?>
        </section>
        <section class="keyrano-order-action" aria-labelledby="keyrano-invoice-heading">
            <p class="keyrano-order-action__label"><?php echo esc_html__('Rechnung', 'keycore-platform'); ?></p>
            <?php if ('AVAILABLE' === $invoice_status && true === ($order['invoice']['downloadAvailable'] ?? false)) : ?>
                <h3 id="keyrano-invoice-heading"><?php echo esc_html__('Verfügbar', 'keycore-platform'); ?></h3>
                <p><?php echo esc_html__('Deine Rechnung steht als geschütztes PDF zum Download bereit.', 'keycore-platform'); ?></p>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="keyrano-invoice-form keyrano-action-form">
                    <input type="hidden" name="action" value="keyrano_invoice">
                    <input type="hidden" name="order_id" value="<?php echo esc_attr((string) $order['orderId']); ?>">
                    <?php wp_nonce_field('keyrano_invoice_' . (string) $order['orderId'], '_wpnonce', false, true); ?>
                    <button type="submit" class="button"><?php echo esc_html__('Rechnung herunterladen', 'keycore-platform'); ?></button>
                </form>
            <?php else : ?>
                <h3 id="keyrano-invoice-heading"><?php echo esc_html__('Noch nicht verfügbar', 'keycore-platform'); ?></h3>
                <p><?php echo esc_html__('Die Rechnung wird erstellt, sobald deine Bestellung abgeschlossen ist.', 'keycore-platform'); ?></p>
            <?php endif; ?>
        </section>
    </div>
<?php endif; ?>
</section>
