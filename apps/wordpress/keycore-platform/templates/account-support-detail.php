<?php defined('ABSPATH') || exit; ?>
<section class="keyrano-account keyrano-account-surface keyrano-support-page">
    <?php if (null === $support_case) : ?>
        <div class="keyrano-empty-state"><strong><?php echo esc_html__('Dieser Supportfall ist nicht verfügbar.', 'keycore-platform'); ?></strong></div>
    <?php else : ?>
        <header class="keyrano-account-page-header"><p class="keyrano-kicker"><?php echo esc_html__('Supportfalldetail', 'keycore-platform'); ?></p><h2><?php echo esc_html(KeyRaNoStorefrontPlugin::support_label((string) ($support_case['category'] ?? 'OTHER'))); ?></h2><p class="keyrano-account-page-header__intro"><?php echo esc_html(KeyRaNoStorefrontPlugin::support_label((string) ($support_case['status'] ?? 'OPEN'))); ?></p></header>
        <ol class="keyrano-support-messages"><?php foreach ($messages as $message) : ?><li><header><strong><?php echo esc_html('CUSTOMER' === ($message['authorType'] ?? '') ? __('Du', 'keycore-platform') : __('KeyRaNo Support', 'keycore-platform')); ?></strong><span><?php echo esc_html(wp_date('d.m.Y H:i', strtotime((string) ($message['createdAt'] ?? '')))); ?></span></header><p><?php echo esc_html((string) ($message['body'] ?? '')); ?></p></li><?php endforeach; ?></ol>
        <?php if (in_array((string) ($support_case['status'] ?? ''), ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL'], true)) : ?>
            <section class="keyrano-form-card"><h3><?php echo esc_html__('Antwort hinzufügen', 'keycore-platform'); ?></h3><p><?php echo esc_html__('Teile keine Passwörter, Kaufcodes oder Produktschlüssel.', 'keycore-platform'); ?></p><form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>"><input type="hidden" name="action" value="keyrano_support_reply"><input type="hidden" name="case_id" value="<?php echo esc_attr((string) ($support_case['id'] ?? '')); ?>"><?php wp_nonce_field('keyrano_support_reply_' . (string) ($support_case['id'] ?? '')); ?><div class="keyrano-field"><label for="keyrano-support-reply"><?php echo esc_html__('Nachricht', 'keycore-platform'); ?></label><textarea id="keyrano-support-reply" name="message" maxlength="5000" required></textarea></div><button type="submit" class="button keyrano-button"><?php echo esc_html__('Antwort senden', 'keycore-platform'); ?></button></form></section>
        <?php endif; ?>
    <?php endif; ?>
</section>
