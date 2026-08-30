# WooCommerce Product Publication

The staging bridge exposes nine deterministic synthetic catalog fixtures. Six
are `ALLOWED`, available and positively priced; blocked, review-required and
unavailable fixtures remain in KeyCore test input but are omitted from the
signed publication manifest.

The WordPress publisher accepts only complete records carrying
`publicationStatus=PUBLISHABLE`, `currency=EUR` and a positive integer minor-unit
price. It uses stable `keyrano-<public-reference>` SKUs, so replay updates the
same product and cannot create a title-based duplicate.

Owned fields are title, price, publication/stock state and KeyRaNo public facts
(platform, region and activation). Existing descriptions are preserved on
update; imagery, categories and unrelated manual metadata are untouched.
Managed products absent from a successful manifest are moved to draft, hidden
and out of stock. A missing, invalid or unsigned bridge response performs no
publication mutation.

No supplier identifier, offer identifier, cost, margin, credential or Product
Key is written to WooCommerce. The existing provider-neutral publication
service and WooCommerce REST adapter remain the durable production publication
foundation; this adapter closes the visible KS-05-06 staging gap without a new
database migration or live supplier sync.
