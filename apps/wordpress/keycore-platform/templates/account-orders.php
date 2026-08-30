<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account">
    <div class="keyrano-account__heading">
        <p class="keyrano-kicker"><?php echo esc_html__('Konto', 'keycore-platform'); ?></p>
        <h2><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></h2>
    </div>
    <?php if ($unavailable) : ?>
        <div class="keyrano-state keyrano-state--error"><?php echo esc_html__('Deine Käufe sind gerade nicht verfügbar. Bitte versuche es später erneut.', 'keycore-platform'); ?></div>
    <?php elseif ([] === $orders) : ?>
        <div class="keyrano-state"><?php echo esc_html__('Noch keine Käufe vorhanden.', 'keycore-platform'); ?></div>
    <?php else : ?>
        <div class="keyrano-purchases">
            <?php foreach ($orders as $order) : ?>
                <article class="keyrano-purchase">
                    <div><p class="keyrano-purchase__date"><?php echo esc_html(wp_date('d.m.Y', strtotime((string) ($order['createdAt'] ?? '')))); ?></p>
                    <h3><?php echo esc_html((string) ($order['productTitle'] ?? __('Digitales Produkt', 'keycore-platform'))); ?></h3></div>
                    <p class="keyrano-status"><?php echo esc_html((string) ($order['status'] ?? __('In Bearbeitung', 'keycore-platform'))); ?></p>
                    <a class="button" href="<?php echo esc_url(wc_get_account_endpoint_url('kauf-details') . rawurlencode((string) ($order['orderId'] ?? '')) . '/'); ?>"><?php echo esc_html__('Details', 'keycore-platform'); ?></a>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</section>
