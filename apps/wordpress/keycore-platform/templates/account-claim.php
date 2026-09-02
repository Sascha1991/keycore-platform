<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account">
    <p class="keyrano-kicker"><?php echo esc_html__('Meine Käufe', 'keycore-platform'); ?></p>
    <h2><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></h2>
    <p><?php echo esc_html__('Gib den sicheren Code für deinen Gastkauf ein.', 'keycore-platform'); ?></p>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" autocomplete="off">
        <input type="hidden" name="action" value="keyrano_claim_purchase">
        <?php wp_nonce_field('keyrano_claim_purchase'); ?>
        <p>
            <label for="keyrano-claim-code"><?php echo esc_html__('Sicherer Kaufcode', 'keycore-platform'); ?></label>
            <input id="keyrano-claim-code" name="claim_code" type="password" minlength="16" maxlength="128" required autocomplete="off" spellcheck="false">
        </p>
        <button type="submit" class="button"><?php echo esc_html__('Kauf hinzufügen', 'keycore-platform'); ?></button>
    </form>
</section>
