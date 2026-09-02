<?php defined('ABSPATH') || exit; ?>
<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title><?php echo esc_html__('Rechnung nicht verfügbar', 'keycore-platform'); ?></title></head>
<body class="keyrano-reveal-page"><main class="keyrano-reveal">
    <h1><?php echo esc_html__('Rechnung nicht verfügbar', 'keycore-platform'); ?></h1>
    <p><?php echo esc_html__('Diese Rechnung ist derzeit nicht verfügbar.', 'keycore-platform'); ?></p>
    <p><a class="button" href="<?php echo esc_url(wc_get_account_endpoint_url('meine-kaeufe')); ?>"><?php echo esc_html__('Zurück zu Meine Käufe', 'keycore-platform'); ?></a></p>
</main></body></html>
