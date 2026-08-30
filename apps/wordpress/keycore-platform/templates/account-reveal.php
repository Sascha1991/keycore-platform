<?php defined('ABSPATH') || exit; ?>
<!doctype html><html <?php language_attributes(); ?>><head><meta charset="<?php bloginfo('charset'); ?>"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title><?php echo esc_html__('Sicherer Key-Zugriff', 'keycore-platform'); ?></title><?php wp_head(); ?></head>
<body class="keyrano-reveal-page"><main class="keyrano-reveal">
    <p class="keyrano-kicker">KeyRaNo</p><h1><?php echo esc_html__('Sicherer Key-Zugriff', 'keycore-platform'); ?></h1>
    <?php if ('' !== $revealed_value) : ?><p><?php echo esc_html__('Dein synthetischer Staging-Key:', 'keycore-platform'); ?></p><code class="keyrano-revealed-value"><?php echo esc_html($revealed_value); ?></code>
    <?php else : ?><div class="keyrano-state keyrano-state--error"><?php echo esc_html__('Der Key kann nicht angezeigt werden.', 'keycore-platform'); ?></div><?php endif; ?>
    <p><a class="button" href="<?php echo esc_url(wc_get_account_endpoint_url('meine-kaeufe')); ?>"><?php echo esc_html__('Zurück zu Meine Käufe', 'keycore-platform'); ?></a></p>
</main><?php wp_footer(); ?></body></html>
