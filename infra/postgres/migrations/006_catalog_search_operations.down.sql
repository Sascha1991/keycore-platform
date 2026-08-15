DROP INDEX IF EXISTS catalog_operations_status_type_idx;
DROP INDEX IF EXISTS catalog_search_documents_text_idx;
DROP INDEX IF EXISTS catalog_search_documents_platforms_idx;
DROP INDEX IF EXISTS catalog_search_documents_exact_filters_idx;
DROP INDEX IF EXISTS catalog_search_documents_title_prefix_idx;

DROP TABLE IF EXISTS catalog_operations;
DROP TABLE IF EXISTS catalog_search_documents;
