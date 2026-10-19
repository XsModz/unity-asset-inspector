# Strict fixed-size export

The repack endpoint now refuses any result that is not **exactly** the uploaded
file's byte length. It does not add fake padding or truncate serialized data.
An error reports the original and resulting byte counts.

This is a safety guard, not a general-purpose fixed-size compressor. Some edits
cannot fit into the original size. Encrypted bundles still require their
corresponding supported decoder/key; compression alone does not decrypt them.
The frontend is configured for Vercel; the session-based Python API needs
persistent hosting as documented in VERCEL_DEPLOY.md.
