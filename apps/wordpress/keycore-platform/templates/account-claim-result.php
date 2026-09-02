<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account">
    <p class="keyrano-kicker"><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></p>
    <h2><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></h2>
    <?php if ('CLAIMED' === $result) : ?>
        <div class="keyrano-state"><strong><?php echo esc_html__('Kauf erfolgreich hinzugefügt.', 'keycore-platform'); ?></strong></div>
        <p><a class="button" href="<?php echo esc_url(wc_get_account_endpoint_url('meine-kaeufe')); ?>"><?php echo esc_html__('Meine Käufe öffnen', 'keycore-platform'); ?></a></p>
    <?php elseif ('TEMPORARILY_UNAVAILABLE' === $result) : ?>
        <div class="keyrano-state"><strong><?php echo esc_html__('Kauf konnte vorübergehend nicht hinzugefügt werden.', 'keycore-platform'); ?></strong></div>
    <?php else : ?>
        <div class="keyrano-state"><strong><?php echo esc_html__('Code ungültig oder Kauf nicht verfügbar.', 'keycore-platform'); ?></strong></div>
    <?php endif; ?>
</section>
