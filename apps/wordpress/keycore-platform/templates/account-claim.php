<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account keyrano-account-surface keyrano-claim-page">
    <nav class="keyrano-breadcrumbs" aria-label="<?php echo esc_attr__('Brotkrümelnavigation', 'keycore-platform'); ?>">
        <a href="<?php echo esc_url(wc_get_account_endpoint_url('dashboard')); ?>"><?php echo esc_html__('Mein Konto', 'keycore-platform'); ?></a>
        <span aria-hidden="true">›</span>
        <span aria-current="page"><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></span>
    </nav>
    <header class="keyrano-account-page-header">
        <p class="keyrano-kicker"><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></p>
        <h2><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></h2>
        <p class="keyrano-account-page-header__intro"><?php echo esc_html__('Ordne einen bestehenden Gastkauf sicher deinem KeyRaNo-Konto zu.', 'keycore-platform'); ?></p>
    </header>
    <section class="keyrano-form-card" aria-labelledby="keyrano-claim-heading">
        <h3 id="keyrano-claim-heading"><?php echo esc_html__('Sicheren Kaufcode eingeben', 'keycore-platform'); ?></h3>
        <p><?php echo esc_html__('Verwende ausschließlich den einmaligen sicheren Code für deinen Gastkauf.', 'keycore-platform'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" autocomplete="off">
            <input type="hidden" name="action" value="keyrano_claim_purchase">
            <?php wp_nonce_field('keyrano_claim_purchase'); ?>
            <div class="keyrano-field">
                <label for="keyrano-claim-code"><?php echo esc_html__('Sicherer Kaufcode', 'keycore-platform'); ?> <span aria-hidden="true">*</span></label>
                <input id="keyrano-claim-code" name="claim_code" type="password" minlength="16" maxlength="128" required autocomplete="off" spellcheck="false">
            </div>
            <button type="submit" class="button keyrano-button"><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></button>
        </form>
    </section>
</section>
