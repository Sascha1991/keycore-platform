<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account keyrano-account-surface keyrano-orders-page">
    <nav class="keyrano-breadcrumbs" aria-label="<?php echo esc_attr__('Brotkrümelnavigation', 'keycore-platform'); ?>">
        <a href="<?php echo esc_url(wc_get_account_endpoint_url('dashboard')); ?>"><?php echo esc_html__('Mein Konto', 'keycore-platform'); ?></a>
        <span aria-hidden="true">›</span>
        <span aria-current="page"><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></span>
    </nav>
    <header class="keyrano-account-page-header keyrano-account-page-header--action">
        <div>
            <p class="keyrano-kicker"><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></p>
            <h2><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></h2>
            <p class="keyrano-account-page-header__intro"><?php echo esc_html__('Alle deine Käufe auf einen Blick.', 'keycore-platform'); ?></p>
        </div>
        <a class="button keyrano-button" href="<?php echo esc_url(wc_get_account_endpoint_url('kauf-hinzufuegen')); ?>"><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></a>
    </header>
    <?php if ($unavailable) : ?>
        <div class="keyrano-state keyrano-state--error">
            <strong><?php echo esc_html__('Deine Käufe sind gerade nicht verfügbar.', 'keycore-platform'); ?></strong>
            <p><?php echo esc_html__('Bitte versuche es später erneut.', 'keycore-platform'); ?></p>
        </div>
    <?php elseif ([] === $orders) : ?>
        <div class="keyrano-state keyrano-empty-state">
            <strong><?php echo esc_html__('Noch keine Käufe vorhanden.', 'keycore-platform'); ?></strong>
            <p><?php echo esc_html__('Sobald du etwas kaufst, erscheint es hier.', 'keycore-platform'); ?></p>
        </div>
    <?php else : ?>
        <div class="keyrano-purchases">
            <?php foreach ($orders as $order) : ?>
                <?php
                $created_at = strtotime((string) ($order['createdAt'] ?? ''));
                $order_date = false === $created_at ? __('Nicht verfügbar', 'keycore-platform') : wp_date('d.m.Y', $created_at);
                $order_status = (string) ($order['status'] ?? 'PENDING');
                $total = \KeyRaNo\Storefront\Plugin::money_label(
                    (string) ($order['totalMinor'] ?? ''),
                    (string) ($order['currency'] ?? '')
                );
                ?>
                <article class="keyrano-purchase">
                    <div class="keyrano-purchase__identity">
                        <h3><?php echo esc_html((string) ($order['productTitle'] ?? __('Digitales Produkt', 'keycore-platform'))); ?></h3>
                        <p class="keyrano-purchase__date"><?php echo esc_html($order_date); ?></p>
                    </div>
                    <dl class="keyrano-purchase__meta">
                        <div>
                            <dt><?php echo esc_html__('Gesamtbetrag', 'keycore-platform'); ?></dt>
                            <dd><?php echo esc_html($total); ?></dd>
                        </div>
                        <div>
                            <dt><?php echo esc_html__('Bestellstatus', 'keycore-platform'); ?></dt>
                            <dd><span class="keyrano-badge keyrano-badge--<?php echo esc_attr(\KeyRaNo\Storefront\Plugin::status_tone($order_status)); ?>"><?php echo esc_html(\KeyRaNo\Storefront\Plugin::status_label($order_status)); ?></span></dd>
                        </div>
                    </dl>
                    <?php if (true === ($order['fulfillmentAvailable'] ?? false)) : ?>
                        <p class="keyrano-purchase__availability"><span class="keyrano-badge keyrano-badge--positive"><?php echo esc_html__('Key verfügbar', 'keycore-platform'); ?></span></p>
                    <?php endif; ?>
                    <a class="button keyrano-button keyrano-purchase__button" href="<?php echo esc_url(wc_get_account_endpoint_url('kauf-details') . rawurlencode((string) ($order['orderId'] ?? '')) . '/'); ?>"><?php echo esc_html__('Details ansehen', 'keycore-platform'); ?></a>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</section>
