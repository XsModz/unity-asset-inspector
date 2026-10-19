# Deployment

Deploy this repository to Vercel as a Vite frontend (build: `npm run build`, output: `dist/public`). The Python Flask backend requires a separate persistent Python host: Vercel stateless functions cannot reliably retain the existing in-memory editing sessions, and its request/body limits can prevent large bundle uploads.

On the backend host install `Flask`, `flask-cors` (if desired), `UnityPy`, and `gunicorn`, then start `gunicorn --bind 0.0.0.0:$PORT --workers 1 backend.app:app`. Configure `FRONTEND_ORIGINS` to the exact Vercel frontend URL. Set Vercel environment variable `VITE_UNITY_API_BASE_URL` to the backend HTTPS origin and redeploy. For multiple backend workers/instances, replace the in-memory sessions with shared storage first.

## Encryption limitation

The supplied sample has a UnityFS header but UnityPy reports encrypted bundle data. No decryption key was provided. Set `UNITY_BUNDLE_DECRYPT_KEY` on the trusted backend only if you have the correct key. This enables an attempted read; it does NOT implement preservation/re-encryption of the original proprietary encryption. Do not replace original encrypted bundles with exports from this version. Exact encrypted round-trip needs the original encryption scheme, key, IV/nonce and format handling, plus a verified reopen test.
