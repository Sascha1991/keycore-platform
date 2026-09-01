<?php

declare(strict_types=1);

namespace KeyRaNo\Storefront;

final class Invoice_Document_Response
{
    private const MAX_BYTES = 524288;

    /** @param array<string, mixed> $request */
    public static function has_exact_request_fields(array $request): bool
    {
        $keys = array_keys($request);
        $expected = ['_wpnonce', 'action', 'order_id'];
        sort($keys);
        sort($expected);
        return $keys === $expected
            && 'keyrano_invoice' === ($request['action'] ?? null)
            && is_string($request['order_id'] ?? null)
            && is_string($request['_wpnonce'] ?? null);
    }

    /** @param array<string, mixed>|null $payload */
    public static function decode(?array $payload): ?string
    {
        if (! is_array($payload) || 200 !== ($payload['_httpStatus'] ?? null) || 'AVAILABLE' !== ($payload['status'] ?? null)) {
            return null;
        }
        $allowed = ['_httpStatus', 'document', 'status'];
        $keys = array_keys($payload);
        sort($allowed);
        sort($keys);
        if ($keys !== $allowed || ! is_array($payload['document'])) {
            return null;
        }
        $document = $payload['document'];
        $document_keys = array_keys($document);
        $expected_document_keys = ['body', 'contentType', 'encoding'];
        sort($document_keys);
        sort($expected_document_keys);
        if (
            $document_keys !== $expected_document_keys
            || 'application/pdf' !== ($document['contentType'] ?? null)
            || 'base64' !== ($document['encoding'] ?? null)
            || ! is_string($document['body'] ?? null)
            || strlen($document['body']) > 700000
        ) {
            return null;
        }
        $bytes = base64_decode($document['body'], true);
        if (
            ! is_string($bytes)
            || '' === $bytes
            || strlen($bytes) > self::MAX_BYTES
            || ! str_starts_with($bytes, '%PDF-')
            || ! str_ends_with($bytes, "%%EOF\n")
        ) {
            return null;
        }
        return $bytes;
    }

    /** @return array<string, string> */
    public static function headers(int $length): array
    {
        if ($length < 1 || $length > self::MAX_BYTES) {
            return [];
        }
        return [
            'Cache-Control' => 'private, no-store, no-cache, must-revalidate',
            'Content-Disposition' => 'attachment; filename="keyrano-rechnung.pdf"',
            'Content-Length' => (string) $length,
            'Content-Type' => 'application/pdf',
            'Expires' => '0',
            'Pragma' => 'no-cache',
            'Referrer-Policy' => 'no-referrer',
            'X-Content-Type-Options' => 'nosniff',
        ];
    }
}
