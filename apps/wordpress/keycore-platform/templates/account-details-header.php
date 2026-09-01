<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account-surface keyrano-account-details-header">
    <nav class="keyrano-breadcrumbs" aria-label="<?php echo esc_attr__('Brotkrümelnavigation', 'keycore-platform'); ?>">
        <a href="<?php echo esc_url(wc_get_account_endpoint_url('dashboard')); ?>"><?php echo esc_html__('Mein Konto', 'keycore-platform'); ?></a>
        <span aria-hidden="true">›</span>
        <span aria-current="page"><?php echo esc_html__('Kontodetails', 'keycore-platform'); ?></span>
    </nav>
    <header class="keyrano-account-page-header">
        <p class="keyrano-kicker"><?php echo esc_html__('Kontodetails', 'keycore-platform'); ?></p>
        <h2><?php echo esc_html__('Kontodetails', 'keycore-platform'); ?></h2>
        <p class="keyrano-account-page-header__intro"><?php echo esc_html__('Verwalte deine persönlichen Daten und deinen Login.', 'keycore-platform'); ?></p>
    </header>
</section>
