<?php

if (! defined('ABSPATH')) {
    throw new RuntimeException('Run this file through WP-CLI.');
}

const KEYRANO_CONTENT_HASH_META = '_keyrano_staging_content_hash';

/** @return array<string, array{title: string, content: string}> */
function keyrano_content_pages(): array
{
    return [
        'haeufige-fragen' => [
            'title' => 'Häufige Fragen',
            'content' => keyrano_faq_content(),
        ],
        'kontakt' => [
            'title' => 'Kontakt',
            'content' => keyrano_contact_content(),
        ],
        'key-aktivieren' => [
            'title' => 'Key aktivieren',
            'content' => keyrano_activation_content(),
        ],
        'bestellstatus' => [
            'title' => 'Bestellstatus',
            'content' => keyrano_order_status_content(),
        ],
        'impressum' => [
            'title' => 'Impressum',
            'content' => keyrano_legal_content([
                'Anbieterkennzeichnung' => '[Unternehmensname, Rechtsform und Anschrift ergänzen]',
                'Vertretung und Register' => '[Vertretungsberechtigte und Registerangaben ergänzen]',
                'Kontakt und Steuerangaben' => '[Rechtlich freigegebene Kontakt- und Steuerangaben ergänzen]',
                'Weitere Pflichtangaben' => '[Geprüfte Pflichtangaben ergänzen]',
            ]),
        ],
        'datenschutz' => [
            'title' => 'Datenschutz',
            'content' => keyrano_legal_content([
                'Verantwortliche Stelle' => '[Verantwortliche Stelle und Kontakt ergänzen]',
                'Verarbeitete Daten und Zwecke' => '[Geprüfte Verarbeitungstätigkeiten und Rechtsgrundlagen ergänzen]',
                'Empfänger und Speicherdauer' => '[Geprüfte Empfänger, Übermittlungen und Löschfristen ergänzen]',
                'Betroffenenrechte' => '[Rechtlich geprüfte Informationen zu Betroffenenrechten ergänzen]',
            ]),
        ],
        'agb' => [
            'title' => 'AGB',
            'content' => keyrano_legal_content([
                'Geltungsbereich und Vertragspartner' => '[Rechtlich geprüften Geltungsbereich und Vertragspartner ergänzen]',
                'Vertragsschluss und Leistung' => '[Rechtlich geprüfte Regelungen ergänzen]',
                'Preise und Zahlung' => '[Rechtlich geprüfte Preis- und Zahlungsbedingungen ergänzen]',
                'Gewährleistung und Haftung' => '[Rechtlich geprüfte Regelungen ergänzen]',
            ]),
        ],
        'widerrufsbelehrung' => [
            'title' => 'Widerrufsbelehrung',
            'content' => keyrano_legal_content([
                'Widerrufsrecht' => '[Rechtlich geprüfte Widerrufsbelehrung ergänzen]',
                'Widerrufsfrist und Ausübung' => '[Geprüfte Frist, Form und Kontaktangaben ergänzen]',
                'Folgen des Widerrufs' => '[Rechtlich geprüfte Folgen ergänzen]',
                'Digitale Inhalte' => '[Rechtlich geprüfte Regelung für digitale Inhalte ergänzen]',
            ]),
        ],
    ];
}

function keyrano_page_intro(string $kicker, string $intro): string
{
    return <<<HTML
<!-- wp:group {"className":"keyrano-content-header","layout":{"type":"constrained"}} -->
<div class="wp-block-group keyrano-content-header"><p class="keyrano-content-kicker">{$kicker}</p><p class="keyrano-content-intro">{$intro}</p></div>
<!-- /wp:group -->
HTML;
}

function keyrano_faq_item(string $question, string $answer): string
{
    return <<<HTML
<!-- wp:details {"className":"keyrano-faq-item"} -->
<details class="wp-block-details keyrano-faq-item"><summary>{$question}</summary><!-- wp:paragraph -->
<p>{$answer}</p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->
HTML;
}

function keyrano_faq_group(string $title, string $items): string
{
    return <<<HTML
<!-- wp:group {"className":"keyrano-content-section keyrano-faq-group","layout":{"type":"constrained"}} -->
<div class="wp-block-group keyrano-content-section keyrano-faq-group"><h2 class="wp-block-heading">{$title}</h2>{$items}</div>
<!-- /wp:group -->
HTML;
}

function keyrano_faq_content(): string
{
    $groups = keyrano_faq_group('Bestellung',
        keyrano_faq_item('Wo finde ich meine Käufe?', 'Melde dich an und öffne unter „Mein Konto“ den Bereich „Meine Käufe“. Dort werden nur Käufe angezeigt, die sicher deinem Konto zugeordnet sind.') .
        keyrano_faq_item('Warum ist ein Kauf noch in Bearbeitung?', 'Ein Kauf kann noch verarbeitet werden. Prüfe den Status später erneut. Ein Produktschlüssel wird auf der normalen Übersichtsseite nicht angezeigt.'));
    $groups .= keyrano_faq_group('Bezahlung',
        keyrano_faq_item('Welche Zahlungsarten sind verfügbar?', 'Die verfügbaren Zahlungsarten werden im Checkout angezeigt. Die aktuelle Staging-Umgebung verwendet ausschließlich ausdrücklich gekennzeichnete synthetische Testzahlungen.'));
    $groups .= keyrano_faq_group('Produktschlüssel',
        keyrano_faq_item('Wann kann ich meinen Key sehen?', 'Ein Key ist nur bei einem berechtigten, verfügbaren Kauf und erst nach der ausdrücklichen sicheren Anzeige sichtbar. Er wird nicht vorab in Seitenquelltext oder Bestellübersichten eingebettet.'));
    $groups .= keyrano_faq_group('Aktivierung',
        keyrano_faq_item('Wo finde ich Aktivierungshilfe?', 'Die Seite „Key aktivieren“ bereitet die Plattformbereiche vor. Verbindliche plattformspezifische Schritte werden erst nach redaktioneller Prüfung ergänzt.'));
    $groups .= keyrano_faq_group('Kundenkonto',
        keyrano_faq_item('Kann ich Käufe eines anderen Kontos öffnen?', 'Nein. Käufe und Details sind nur für das zugeordnete Kundenkonto verfügbar. Bei einer abweichenden Zuordnung wird keine Bestellung offengelegt.'));
    $groups .= keyrano_faq_group('Rechnung',
        keyrano_faq_item('Wann ist eine Rechnung verfügbar?', 'Der Kaufbereich zeigt an, ob ein Dokument verfügbar ist. Staging-Dokumente sind ausschließlich synthetische Testartefakte und keine rechtlich gültigen Rechnungen.'));
    $groups .= keyrano_faq_group('Probleme &amp; Support',
        keyrano_faq_item('Welche Angaben helfen bei einer Anfrage?', 'Halte die sichtbare Bestellnummer und eine kurze Fehlerbeschreibung bereit. Sende niemals Passwörter oder Produktschlüssel. Ein sicherer Kontaktkanal wird auf der Kontaktseite ausgewiesen, sobald er freigegeben ist.'));

    return '<!-- wp:group {"className":"keyrano-content-shell keyrano-faq-page","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-shell keyrano-faq-page">' .
        keyrano_page_intro('Hilfe &amp; Service', 'Kurze Antworten zu Bestellung, Konto und sicherer Bereitstellung.') .
        '<!-- wp:group {"className":"keyrano-faq-list","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-faq-list">' . $groups . '</div><!-- /wp:group --></div><!-- /wp:group -->';
}

function keyrano_contact_content(): string
{
    return '<!-- wp:group {"className":"keyrano-content-shell","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-shell">' .
        keyrano_page_intro('Hilfe &amp; Service', 'Bereite deine Anfrage vor, ohne vertrauliche Daten oder Produktschlüssel zu übermitteln.') .
        '<!-- wp:columns {"className":"keyrano-content-grid"} --><div class="wp-block-columns keyrano-content-grid">' .
        '<!-- wp:column --><div class="wp-block-column keyrano-content-card"><h2 class="wp-block-heading">Hilfreiche Angaben</h2><ul><li>sichtbare Bestellnummer</li><li>betroffenes Produkt</li><li>kurze Fehlerbeschreibung</li><li>Zeitpunkt des Problems</li></ul></div><!-- /wp:column -->' .
        '<!-- wp:column --><div class="wp-block-column keyrano-content-card"><h2 class="wp-block-heading">Kontaktkanal</h2><p class="keyrano-placeholder">[Freigegebenen Support-Kontakt ergänzen]</p><p>Ein sicherer Support- und Mail-Workflow ist noch nicht angebunden. Diese Seite sendet keine Nachricht.</p></div><!-- /wp:column -->' .
        '</div><!-- /wp:columns -->' .
        '<!-- wp:paragraph {"className":"keyrano-content-notice"} --><p class="keyrano-content-notice"><strong>Sicherheitshinweis:</strong> Teile niemals Passwörter, vollständige Produktschlüssel oder Zahlungsdaten.</p><!-- /wp:paragraph -->' .
        '</div><!-- /wp:group -->';
}

function keyrano_activation_card(string $platform): string
{
    return '<!-- wp:column --><div class="wp-block-column keyrano-content-card keyrano-activation-card"><h2 class="wp-block-heading">' . $platform . '</h2><p class="keyrano-placeholder">[Offizielle Aktivierungsschritte ergänzen]</p><p>Bis zur redaktionellen Freigabe gelten ausschließlich die Hinweise des jeweiligen Plattformanbieters.</p></div><!-- /wp:column -->';
}

function keyrano_activation_content(): string
{
    $platforms = ['Steam', 'Epic Games', 'EA App', 'Ubisoft Connect', 'Battle.net', 'Microsoft / Xbox', 'PlayStation', 'Nintendo'];
    $cards = '';
    foreach ($platforms as $platform) {
        $cards .= keyrano_activation_card($platform);
    }

    return '<!-- wp:group {"className":"keyrano-content-shell","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-shell">' .
        keyrano_page_intro('Hilfe &amp; Service', 'Wähle die passende Plattform. Verbindliche Schritte werden erst nach fachlicher Prüfung veröffentlicht.') .
        '<!-- wp:columns {"className":"keyrano-content-grid keyrano-activation-grid"} --><div class="wp-block-columns keyrano-content-grid keyrano-activation-grid">' . $cards . '</div><!-- /wp:columns -->' .
        '</div><!-- /wp:group -->';
}

function keyrano_order_status_content(): string
{
    $account_url = esc_url(home_url('/my-account/meine-kaeufe/'));

    return '<!-- wp:group {"className":"keyrano-content-shell","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-shell">' .
        keyrano_page_intro('Hilfe &amp; Service', 'Deinen persönlichen Bestellstatus findest du ausschließlich im geschützten Kundenkonto.') .
        '<!-- wp:group {"className":"keyrano-content-card keyrano-status-guide","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-card keyrano-status-guide"><h2 class="wp-block-heading">So findest du deinen Kauf</h2><ol><li>Melde dich unter „Mein Konto“ an.</li><li>Öffne „Meine Käufe“.</li><li>Wähle den gewünschten Kauf, um den aktuellen sicheren Status zu sehen.</li></ol><!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="' . $account_url . '">Meine Käufe öffnen</a></div><!-- /wp:button --></div><!-- /wp:buttons --></div><!-- /wp:group -->' .
        '<!-- wp:paragraph {"className":"keyrano-content-notice"} --><p class="keyrano-content-notice">Es gibt keine öffentliche Suche per Bestellnummer oder E-Mail-Adresse. So bleiben Bestelldaten vor fremdem Zugriff geschützt.</p><!-- /wp:paragraph -->' .
        '</div><!-- /wp:group -->';
}

/** @param array<string, string> $sections */
function keyrano_legal_content(array $sections): string
{
    $body = '';
    foreach ($sections as $heading => $placeholder) {
        $body .= '<!-- wp:group {"className":"keyrano-legal-section","layout":{"type":"constrained"}} --><section class="wp-block-group keyrano-legal-section"><h2 class="wp-block-heading">' . $heading . '</h2><p class="keyrano-placeholder">' . $placeholder . '</p></section><!-- /wp:group -->';
    }

    return '<!-- wp:group {"className":"keyrano-content-shell keyrano-legal-page","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-content-shell keyrano-legal-page">' .
        keyrano_page_intro('Rechtliches', 'Vorbereitete Inhaltsstruktur für die spätere rechtliche Prüfung und Freigabe.') .
        '<!-- wp:paragraph {"className":"keyrano-content-notice keyrano-content-notice--warning"} --><p class="keyrano-content-notice keyrano-content-notice--warning"><strong>Entwurf:</strong> Dieser Inhalt ist nicht rechtlich geprüft und nicht produktionsbereit.</p><!-- /wp:paragraph -->' .
        '<!-- wp:group {"className":"keyrano-legal-body","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-legal-body">' . $body . '</div><!-- /wp:group -->' .
        '</div><!-- /wp:group -->';
}

function keyrano_content_hash(string $content): string
{
    return hash('sha256', $content);
}

/** @return array{created: int, preserved: int, updated: int} */
function keyrano_ensure_pages(): array
{
    $result = ['created' => 0, 'preserved' => 0, 'updated' => 0];

    foreach (keyrano_content_pages() as $slug => $page) {
        $existing = get_page_by_path($slug, OBJECT, 'page');
        if (! $existing instanceof WP_Post) {
            $post_id = wp_insert_post([
                'post_content' => $page['content'],
                'post_name' => $slug,
                'post_status' => 'publish',
                'post_title' => $page['title'],
                'post_type' => 'page',
            ], true);
            if (is_wp_error($post_id)) {
                throw new RuntimeException('Could not create KeyRaNo page: ' . $slug);
            }
            update_post_meta((int) $post_id, KEYRANO_CONTENT_HASH_META, keyrano_content_hash($page['content']));
            ++$result['created'];
            continue;
        }

        $managed_hash = (string) get_post_meta($existing->ID, KEYRANO_CONTENT_HASH_META, true);
        if ($managed_hash === '' || ! hash_equals($managed_hash, keyrano_content_hash((string) $existing->post_content))) {
            ++$result['preserved'];
            continue;
        }

        if ((string) $existing->post_content !== $page['content'] || (string) $existing->post_title !== $page['title']) {
            $updated = wp_update_post([
                'ID' => $existing->ID,
                'post_content' => $page['content'],
                'post_title' => $page['title'],
            ], true);
            if (is_wp_error($updated)) {
                throw new RuntimeException('Could not update KeyRaNo page: ' . $slug);
            }
            ++$result['updated'];
        }
        update_post_meta($existing->ID, KEYRANO_CONTENT_HASH_META, keyrano_content_hash($page['content']));
    }

    return $result;
}

/** @return array<string, string> */
function keyrano_shop_categories(): array
{
    return [
        'Games' => 'games',
        'Software' => 'software',
        'Gutscheinkarten' => 'gutscheinkarten-prepaid',
        'Abonnements' => 'abonnements',
    ];
}

function keyrano_ensure_shop_categories(): void
{
    $names = [
        'games' => 'Games',
        'software' => 'Software',
        'gutscheinkarten-prepaid' => 'Gutscheinkarten & Prepaid',
        'abonnements' => 'Abonnements',
    ];
    foreach ($names as $slug => $name) {
        if (! term_exists($slug, 'product_cat')) {
            $created = wp_insert_term($name, 'product_cat', ['slug' => $slug]);
            if (is_wp_error($created)) {
                throw new RuntimeException('Could not create required shop category: ' . $slug);
            }
        }
    }
}

function keyrano_navigation_column(string $heading, array $links): array
{
    $navigation = '';
    foreach ($links as $label => $path) {
        $attrs = wp_json_encode([
            'label' => $label,
            'type' => 'custom',
            'url' => esc_url(home_url($path)),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $navigation .= '<!-- wp:navigation-link ' . $attrs . ' /-->';
    }
    $markup = '<!-- wp:column --><div class="wp-block-column keyrano-footer-column"><h4 class="wp-block-heading">' . $heading . '</h4><!-- wp:navigation {"overlayMenu":"never","layout":{"type":"flex","orientation":"vertical"}} --><nav class="is-vertical wp-block-navigation">' . $navigation . '</nav><!-- /wp:navigation --></div><!-- /wp:column -->';

    $blocks = parse_blocks($markup);
    return $blocks[0];
}

function keyrano_fresh_footer(): string
{
    $shop = [];
    foreach (keyrano_shop_categories() as $label => $slug) {
        $shop[$label] = '/product-category/' . $slug . '/';
    }
    $columns = [
        keyrano_navigation_column('Shop', $shop),
        keyrano_navigation_column('Hilfe &amp; Service', keyrano_help_links()),
        keyrano_navigation_column('Rechtliches', keyrano_legal_links()),
    ];
    $columns_markup = serialize_blocks($columns);

    return '<!-- wp:group {"className":"keyrano-site-footer","layout":{"type":"constrained"}} --><div class="wp-block-group keyrano-site-footer"><!-- wp:site-title {"level":2} /--><!-- wp:columns {"className":"keyrano-footer-columns"} --><div class="wp-block-columns keyrano-footer-columns">' . $columns_markup . '</div><!-- /wp:columns --><!-- wp:paragraph {"align":"center","fontSize":"small"} --><p class="has-text-align-center has-small-font-size">© ' . gmdate('Y') . ' KeyRaNo · Alle Rechte vorbehalten.</p><!-- /wp:paragraph --></div><!-- /wp:group -->';
}

/** @return array<string, string> */
function keyrano_help_links(): array
{
    return [
        'Häufige Fragen' => '/haeufige-fragen/',
        'Kontakt' => '/kontakt/',
        'Key aktivieren' => '/key-aktivieren/',
        'Bestellstatus' => '/bestellstatus/',
    ];
}

/** @return array<string, string> */
function keyrano_legal_links(): array
{
    return [
        'Impressum' => '/impressum/',
        'Datenschutz' => '/datenschutz/',
        'AGB' => '/agb/',
        'Widerrufsbelehrung' => '/widerrufsbelehrung/',
    ];
}

function keyrano_block_text(array $block): string
{
    $text = wp_strip_all_tags((string) ($block['innerHTML'] ?? ''));
    foreach (($block['innerBlocks'] ?? []) as $inner) {
        $text .= ' ' . keyrano_block_text($inner);
    }
    return trim(html_entity_decode(preg_replace('/\s+/u', ' ', $text) ?? '', ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function keyrano_footer_column_index(array $columns, string $heading): ?int
{
    foreach ($columns as $index => $column) {
        if (str_contains(keyrano_block_text($column), $heading)) {
            return $index;
        }
    }
    return null;
}

function keyrano_column_is_empty(array $column): bool
{
    return keyrano_block_text($column) === '' && empty($column['innerBlocks']);
}

function keyrano_rewrite_shop_links(array &$block): void
{
    if (($block['blockName'] ?? '') === 'core/navigation-link') {
        $label = html_entity_decode((string) ($block['attrs']['label'] ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $categories = keyrano_shop_categories();
        if (isset($categories[$label])) {
            $slug = $categories[$label];
            if (! term_exists($slug, 'product_cat')) {
                throw new RuntimeException('Shop category is missing: ' . $slug);
            }
            $block['attrs']['url'] = esc_url(home_url('/product-category/' . $slug . '/'));
        }
    }
    foreach (($block['innerBlocks'] ?? []) as &$inner) {
        keyrano_rewrite_shop_links($inner);
    }
}

function keyrano_enhance_columns(array &$block): bool
{
    if (($block['blockName'] ?? '') === 'core/columns') {
        $columns = &$block['innerBlocks'];
        $shop_index = keyrano_footer_column_index($columns, 'Shop');
        if ($shop_index !== null) {
            keyrano_rewrite_shop_links($columns[$shop_index]);
            $help_index = keyrano_footer_column_index($columns, 'Hilfe & Service');
            $legal_index = keyrano_footer_column_index($columns, 'Rechtliches');
            $available = [];
            foreach ($columns as $index => $column) {
                if ($index !== $shop_index && keyrano_column_is_empty($column)) {
                    $available[] = $index;
                }
            }
            if ($help_index === null) {
                $target = array_shift($available);
                if ($target === null) {
                    throw new RuntimeException('Footer has no empty column for Hilfe & Service. Manual content was preserved.');
                }
                $columns[$target] = keyrano_navigation_column('Hilfe &amp; Service', keyrano_help_links());
            }
            if ($legal_index === null) {
                $target = array_shift($available);
                if ($target === null) {
                    throw new RuntimeException('Footer has no empty column for Rechtliches. Manual content was preserved.');
                }
                $columns[$target] = keyrano_navigation_column('Rechtliches', keyrano_legal_links());
            }
            $classes = preg_split('/\s+/', trim((string) ($block['attrs']['className'] ?? ''))) ?: [];
            if (! in_array('keyrano-footer-columns', $classes, true)) {
                $classes[] = 'keyrano-footer-columns';
            }
            $block['attrs']['className'] = trim(implode(' ', $classes));
            return true;
        }
    }

    foreach (($block['innerBlocks'] ?? []) as &$inner) {
        if (keyrano_enhance_columns($inner)) {
            return true;
        }
    }
    return false;
}

function keyrano_footer_post(): ?WP_Post
{
    $theme = get_stylesheet();
    $posts = get_posts([
        'name' => 'footer',
        'numberposts' => 20,
        'post_status' => ['publish', 'draft'],
        'post_type' => 'wp_template_part',
        'suppress_filters' => false,
    ]);
    foreach ($posts as $post) {
        $themes = wp_get_object_terms($post->ID, 'wp_theme', ['fields' => 'slugs']);
        if (! is_wp_error($themes) && in_array($theme, $themes, true)) {
            return $post;
        }
    }
    return null;
}

function keyrano_ensure_footer(): string
{
    $post = keyrano_footer_post();
    if (! $post instanceof WP_Post) {
        $post_id = wp_insert_post([
            'post_content' => keyrano_fresh_footer(),
            'post_name' => 'footer',
            'post_status' => 'publish',
            'post_title' => 'Footer',
            'post_type' => 'wp_template_part',
        ], true);
        if (is_wp_error($post_id)) {
            throw new RuntimeException('Could not create the editable KeyRaNo footer.');
        }
        wp_set_object_terms((int) $post_id, get_stylesheet(), 'wp_theme');
        wp_set_object_terms((int) $post_id, 'footer', 'wp_template_part_area');
        return 'created';
    }

    $blocks = parse_blocks((string) $post->post_content);
    $changed = false;
    foreach ($blocks as &$block) {
        if (keyrano_enhance_columns($block)) {
            $changed = true;
            break;
        }
    }
    if (! $changed) {
        throw new RuntimeException('Existing footer has no recognizable Shop column; it was not overwritten.');
    }
    $serialized = serialize_blocks($blocks);
    if ($serialized !== (string) $post->post_content) {
        $updated = wp_update_post(['ID' => $post->ID, 'post_content' => $serialized], true);
        if (is_wp_error($updated)) {
            throw new RuntimeException('Could not update the editable KeyRaNo footer.');
        }
        return 'updated';
    }
    return 'unchanged';
}

keyrano_ensure_shop_categories();
$page_result = keyrano_ensure_pages();
$footer_result = keyrano_ensure_footer();

WP_CLI::log(sprintf(
    'KeyRaNo content bootstrap: pages created=%d updated=%d preserved=%d; footer=%s',
    $page_result['created'],
    $page_result['updated'],
    $page_result['preserved'],
    $footer_result
));
