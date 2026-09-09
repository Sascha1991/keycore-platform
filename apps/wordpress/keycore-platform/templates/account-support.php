<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account keyrano-account-surface keyrano-support-page">
    <header class="keyrano-account-page-header">
        <p class="keyrano-kicker"><?php echo esc_html__('Kundenservice', 'keycore-platform'); ?></p>
        <h2><?php echo esc_html__('Support', 'keycore-platform'); ?></h2>
        <p class="keyrano-account-page-header__intro"><?php echo esc_html__('Erstelle eine Anfrage oder öffne den Verlauf eines bestehenden Supportfalls.', 'keycore-platform'); ?></p>
    </header>
    <?php if ($unavailable) : ?>
        <div class="keyrano-empty-state"><strong><?php echo esc_html__('Support ist vorübergehend nicht verfügbar.', 'keycore-platform'); ?></strong></div>
    <?php else : ?>
        <section class="keyrano-form-card" aria-labelledby="keyrano-support-create">
            <h3 id="keyrano-support-create"><?php echo esc_html__('Neue Supportanfrage', 'keycore-platform'); ?></h3>
            <p><?php echo esc_html__('Teile keine Passwörter, Kaufcodes oder Produktschlüssel in deiner Nachricht.', 'keycore-platform'); ?></p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="keyrano_support_create">
                <?php wp_nonce_field('keyrano_support_create'); ?>
                <div class="keyrano-field"><label for="keyrano-support-category"><?php echo esc_html__('Thema', 'keycore-platform'); ?></label><select id="keyrano-support-category" name="category" required><option value="ACCOUNT_PROBLEM"><?php echo esc_html__('Kontoproblem', 'keycore-platform'); ?></option><option value="ORDER_STATUS"><?php echo esc_html__('Bestellstatus', 'keycore-platform'); ?></option><option value="KEY_NOT_AVAILABLE"><?php echo esc_html__('Produktschlüssel nicht verfügbar', 'keycore-platform'); ?></option><option value="INVOICE_PROBLEM"><?php echo esc_html__('Rechnungsproblem', 'keycore-platform'); ?></option><option value="PAYMENT_PROBLEM"><?php echo esc_html__('Zahlungsproblem', 'keycore-platform'); ?></option><option value="REFUND_REQUEST"><?php echo esc_html__('Erstattungsanfrage', 'keycore-platform'); ?></option><option value="OTHER"><?php echo esc_html__('Sonstiges', 'keycore-platform'); ?></option></select></div>
                <div class="keyrano-field"><label for="keyrano-support-order"><?php echo esc_html__('Zugehöriger Kauf', 'keycore-platform'); ?></label><select id="keyrano-support-order" name="order_id"><option value=""><?php echo esc_html__('Kein Kauf (nur bei Kontoproblem)', 'keycore-platform'); ?></option><?php foreach ($orders as $order) : ?><option value="<?php echo esc_attr((string) ($order['orderId'] ?? '')); ?>"><?php echo esc_html((string) ($order['productTitle'] ?? __('Digitales Produkt', 'keycore-platform'))); ?></option><?php endforeach; ?></select></div>
                <div class="keyrano-field"><label for="keyrano-support-message"><?php echo esc_html__('Nachricht', 'keycore-platform'); ?></label><textarea id="keyrano-support-message" name="message" maxlength="5000" required></textarea></div>
                <button type="submit" class="button keyrano-button"><?php echo esc_html__('Supportanfrage senden', 'keycore-platform'); ?></button>
            </form>
        </section>
        <section class="keyrano-support-list" aria-labelledby="keyrano-support-cases">
            <h3 id="keyrano-support-cases"><?php echo esc_html__('Meine Supportfälle', 'keycore-platform'); ?></h3>
            <?php if ([] === $cases) : ?><div class="keyrano-empty-state"><strong><?php echo esc_html__('Keine Supportfälle verfügbar.', 'keycore-platform'); ?></strong></div><?php endif; ?>
            <?php foreach ($cases as $case) : ?>
                <article class="keyrano-support-case"><div><strong><?php echo esc_html(KeyRaNoStorefrontPlugin::support_label((string) ($case['category'] ?? 'OTHER'))); ?></strong><span><?php echo esc_html(wp_date('d.m.Y H:i', strtotime((string) ($case['updatedAt'] ?? '')))); ?></span></div><span class="keyrano-status keyrano-status--<?php echo esc_attr(KeyRaNoStorefrontPlugin::status_tone((string) ($case['status'] ?? ''))); ?>"><?php echo esc_html(KeyRaNoStorefrontPlugin::support_label((string) ($case['status'] ?? ''))); ?></span><a class="button keyrano-button" href="<?php echo esc_url(wc_get_account_endpoint_url('support-details') . rawurlencode((string) ($case['id'] ?? '')) . '/'); ?>"><?php echo esc_html__('Öffnen', 'keycore-platform'); ?></a></article>
            <?php endforeach; ?>
        </section>
    <?php endif; ?>
</section>
